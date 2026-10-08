"""Benchmark evaluation records stored beside MLflow's tracking tables.

Sections: Tables, Validation, Records. Each evaluation owns its metrics and
parameters; the evaluated model file remains owned by MLflow's artifact store.
Each run has one current result per model file, dataset name and test hash,
and the dataset identity must be a version registered in MLflow.
All content hashes use MD5. Previously imported results remain readable.

Naming table: ``validate_*`` checks input, ``create_*`` inserts, ``get_*`` reads
one record, and ``list_*`` reads a collection.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any
from weakref import WeakSet

import sqlalchemy
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
)
from sqlalchemy.orm import declarative_base, relationship

from mlflow.deeplore import dataset_registry
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE
from mlflow.store.tracking.dbmodels.models import SqlRun

if TYPE_CHECKING:
    from contextlib import AbstractContextManager

    from sqlalchemy.engine import Engine
    from sqlalchemy.orm import Session

    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

# ===== Tables =====

_Base = declarative_base()
_initialized_engines: WeakSet[Engine] = WeakSet()
_initialization_lock = threading.Lock()


class SqlEvaluation(_Base):
    """Own one current evaluation of a model file on a dataset version.

    The dataset identity is a registered dataset version, whose test hash is
    the evaluation's ``dataset_hash``. The model file's bytes remain in the
    associated run's artifact store.
    """

    __tablename__ = "deeplore_evaluations"
    __table_args__ = (
        Index("index_deeplore_evaluations_run_time", "run_id", "evaluation_time"),
        Index(
            "index_deeplore_evaluations_run_model_dataset_version",
            "run_id",
            "checkpoint_path",
            "dataset_name",
            "dataset_version",
            unique=True,
        ),
        ForeignKeyConstraint(
            ["dataset_name", "dataset_version"],
            [
                dataset_registry.SqlDatasetVersion.name,
                dataset_registry.SqlDatasetVersion.version,
            ],
            name="evaluation_dataset_version",
        ),
        CheckConstraint(
            "association_status IN ('confirmed', 'pending')",
            name="evaluation_association_status",
        ),
        CheckConstraint(
            "association_status != 'confirmed' OR "
            "(dataset_name IS NOT NULL AND dataset_version IS NOT NULL)",
            name="evaluation_confirmed_identity",
        ),
    )

    evaluation_id = Column(String(32), primary_key=True)
    run_id = Column(
        String(32), ForeignKey(SqlRun.run_uuid, ondelete="CASCADE"), nullable=False
    )
    dataset_name = Column(String(256))
    dataset_version = Column(String(64))
    association_status = Column(String(16), nullable=False)
    benchmark_name = Column(String(256), nullable=False)
    # The columns predate evaluating model files other than checkpoints.
    model_path = Column("checkpoint_path", String(1024))
    model_hash = Column("checkpoint_hash", String(32))
    evaluation_time = Column(BigInteger)
    metrics_json = Column("metrics", Text, nullable=False)
    params_json = Column("params", Text, nullable=False)
    metadata_json = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    dataset_version_record = relationship(
        dataset_registry.SqlDatasetVersion, lazy="joined"
    )

    # ---- Serialization ----

    @property
    def dataset_hash(self) -> str | None:
        """Return the test hash of the associated immutable dataset version."""
        if self.dataset_version_record is None:
            return None
        content_hash = json.loads(self.dataset_version_record.hashes).get("test")
        return content_hash.lower() if isinstance(content_hash, str) else None

    def to_dict(self) -> dict[str, Any]:
        """Return the evaluation without internal dataset evidence."""
        return {
            "evaluation_id": self.evaluation_id,
            "run_id": self.run_id,
            "evaluation_time": self.evaluation_time,
            "dataset_name": self.dataset_name,
            "dataset_version": self.dataset_version,
            "dataset_hash": self.dataset_hash,
            "association_status": self.association_status,
            "benchmark_name": self.dataset_name or self.benchmark_name,
            "model_path": self.model_path,
            "model_hash": self.model_hash,
            "metrics": json.loads(self.metrics_json),
            "params": json.loads(self.params_json),
            "created_at": self.created_at,
        }


# Unique keys of earlier revisions, which allowed one model file per dataset version.
_LEGACY_UNIQUE_INDEXES: tuple[str, ...] = (
    "index_deeplore_evaluations_run_dataset_version",
    "index_deeplore_evaluations_run_dataset_test",
)


def _ensure_indexes(engine: Engine) -> None:
    """Swap an earlier revision's unique key for the one that holds the model file."""
    reflected = sqlalchemy.Table(
        SqlEvaluation.__tablename__,
        sqlalchemy.MetaData(),
        autoload_with=engine,
        resolve_fks=False,
    )
    try:
        for index in reflected.indexes:
            if index.name in _LEGACY_UNIQUE_INDEXES:
                index.drop(engine)
        for index in SqlEvaluation.__table__.indexes:
            index.create(engine, checkfirst=True)
    except sqlalchemy.exc.OperationalError:
        # Another server worker swapped the indexes first.
        pass


def _session(store: SqlAlchemyStore) -> AbstractContextManager[Session]:
    with _initialization_lock:
        if store.engine not in _initialized_engines:
            with dataset_registry._session(store):
                pass
            _Base.metadata.create_all(store.engine, checkfirst=True)
            _ensure_indexes(store.engine)
            _initialized_engines.add(store.engine)
    return store.ManagedSessionMaker()


# ===== Validation =====


def _invalid(message: str) -> MlflowException:
    return MlflowException(message, error_code=INVALID_PARAMETER_VALUE)


def _validate_json(value: Any, field: str) -> str:
    try:
        return json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise _invalid(f"{field} must contain finite JSON-compatible values") from error


def _validate_text(
    record: dict[str, Any], key: str, limit: int, required: bool
) -> str | None:
    value = record.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise _invalid(
            f"{key} must be a nonempty string without surrounding whitespace"
        )
    if len(value) > limit:
        raise _invalid(f"{key} must contain at most {limit} characters")
    return value


def _validate_artifact_path(value: str | None, field: str) -> None:
    if value is None:
        return
    path = Path(value)
    if (
        path.is_absolute()
        or ".." in path.parts
        or "\\" in value
        or ":" in value
        or path.as_posix() != value
        or value == "."
    ):
        raise _invalid(
            f"{field} must be a normalized relative path within this run's artifacts"
        )


def validate_dataset_test(
    store: SqlAlchemyStore,
    name: str,
    version: str,
    dataset_hash: str,
) -> dict[str, Any]:
    """Require a registered dataset version whose test split has the given hash.

    The registry is the only evidence: a version it does not hold was never
    released, whatever a working tree or an earlier run claims.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name.
        version: Dataset version.
        dataset_hash: Normalized hash of the test split that was evaluated.

    Returns:
        The registered dataset version.

    Raises:
        MlflowException: If the dataset is archived, the version is not
            registered or has no test split, or the hash differs.
    """
    entry = dataset_registry.get_dataset(store, name)
    if entry and entry["archived"]:
        raise _invalid(f"dataset {name!r} is archived and cannot be evaluated on")
    released = next(
        (
            row
            for row in dataset_registry.list_dataset_versions(store, name)
            if row["version"] == version
        ),
        None,
    )
    if released is None:
        raise _invalid(f"dataset {name!r} {version!r} is not registered in MLflow")
    content_hash = released["hashes"].get("test")
    if (
        not isinstance(content_hash, str)
        or re.fullmatch(r"[0-9a-fA-F]{32}(?:\.dir)?", content_hash) is None
    ):
        raise _invalid(f"dataset {name!r} {version!r} has no test split")
    if content_hash.lower() != dataset_hash:
        raise _invalid(
            "dataset_hash does not match the registered test hash of dataset "
            f"{name!r} {version!r}: expected {content_hash.lower()!r}"
        )
    return released


def validate_metrics(released: dict[str, Any], metrics: dict[str, Any]) -> None:
    """Require every metric the dataset version declares.

    A declared name is recorded by a metric of that name or by a family of
    ``<name>/<member>`` metrics, e.g. ``per_class_AP/<category>``.

    Args:
        released: The registered dataset version.
        metrics: The evaluation's metrics.

    Raises:
        MlflowException: If a declared metric is absent.
    """
    declared = released["metadata"].get("metrics") or []
    missing = [
        name
        for name in declared
        if isinstance(name, str)
        and name not in metrics
        and not any(key.startswith(f"{name}/") for key in metrics)
    ]
    if missing:
        raise _invalid(
            f"metrics lack {', '.join(missing)}, which dataset {released['name']!r} "
            f"{released['version']!r} requires"
        )


def _validate_record(record: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise _invalid("evaluation must be a JSON object")
    fields: dict[str, Any] = {}
    for key, limit in (("dataset_name", 256), ("dataset_version", 64)):
        fields[key] = _validate_text(record, key, limit, True)
    fields["association_status"] = "confirmed"
    fields["benchmark_name"] = fields["dataset_name"]
    for key, pattern, limit in (
        ("dataset_hash", r"[0-9a-fA-F]{32}(?:\.dir)?", 36),
        ("model_hash", r"[0-9a-fA-F]{32}", 32),
    ):
        value = _validate_text(record, key, limit, True)
        if re.fullmatch(pattern, value) is None:
            suffix = ", optionally .dir" if key == "dataset_hash" else ""
            raise _invalid(f"{key} must be a complete hexadecimal MD5 digest{suffix}")
        fields[key] = value.lower()
    fields["model_path"] = _validate_text(record, "model_path", 1024, True)
    _validate_artifact_path(fields["model_path"], "model_path")

    evaluation_time = record.get("evaluation_time")
    if type(evaluation_time) is not int or evaluation_time < 0:
        raise _invalid(
            "evaluation_time must be a nonnegative Unix timestamp in milliseconds"
        )
    fields["evaluation_time"] = evaluation_time

    metrics = record.get("metrics")
    if not isinstance(metrics, dict) or not metrics:
        raise _invalid("metrics must be a nonempty JSON object")
    for key, value in metrics.items():
        if not isinstance(key, str) or not key:
            raise _invalid("metric names must be nonempty strings")
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise _invalid(f"metric {key!r} must be a finite number")
    fields["metrics_json"] = _validate_json(metrics, "metrics")

    parameters = record.get("params", {})
    if not isinstance(parameters, dict):
        raise _invalid("params must be a JSON object")
    for key, value in parameters.items():
        if not isinstance(key, str) or not key:
            raise _invalid("parameter names must be nonempty strings")
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise _invalid(
                f"parameter {key!r} must be a string, number, boolean or null"
            )
        if isinstance(value, float) and not math.isfinite(value):
            raise _invalid(f"parameter {key!r} must be finite")
    fields["params_json"] = _validate_json(parameters, "params")

    return fields


# ===== Records =====


def _get_matching_evaluation(
    session: Session, run_id: str, fields: dict[str, Any], dataset_hash: str
) -> SqlEvaluation | None:
    """Find the run's result for this model file on this test hash.

    Versions that share the test hash share the result. A result imported
    without a model file is adopted by the first write for its test hash.
    """
    versions = session.execute(
        sqlalchemy.select(dataset_registry.SqlDatasetVersion).where(
            dataset_registry.SqlDatasetVersion.name == fields["dataset_name"]
        )
    ).scalars()
    matching_versions = [
        row.version
        for row in versions
        if (json.loads(row.hashes).get("test") or "").lower() == dataset_hash
    ]
    rows = (
        session.execute(
            sqlalchemy.select(SqlEvaluation)
            .where(
                SqlEvaluation.run_id == run_id,
                SqlEvaluation.dataset_name == fields["dataset_name"],
                SqlEvaluation.dataset_version.in_(matching_versions),
                sqlalchemy.or_(
                    SqlEvaluation.model_path == fields["model_path"],
                    SqlEvaluation.model_path.is_(None),
                ),
            )
            .order_by(SqlEvaluation.created_at, SqlEvaluation.evaluation_id)
            .with_for_update(of=SqlEvaluation)
        )
        .scalars()
        .all()
    )
    exact = [row for row in rows if row.model_path == fields["model_path"]]
    return (exact or rows or [None])[0]


def _write_evaluation(
    session: Session, run_id: str, fields: dict[str, Any], dataset_hash: str
) -> tuple[dict[str, Any], bool, str]:
    with session.begin_nested():
        row = _get_matching_evaluation(session, run_id, fields, dataset_hash)
        created = row is None
        if created:
            row = SqlEvaluation(
                evaluation_id=uuid.uuid4().hex,
                run_id=run_id,
                created_at=int(time.time() * 1000),
                **fields,
            )
            session.add(row)
        else:
            for key, value in fields.items():
                setattr(row, key, value)
        session.flush()
        session.expire(row, ["dataset_version_record"])
        return row.to_dict(), created, "created" if created else "updated"


def create_evaluation(
    store: SqlAlchemyStore,
    run_id: str,
    record: dict[str, Any],
) -> tuple[dict[str, Any], bool, str]:
    """Write a run's result for one model file on one dataset test hash.

    A result for the same run, model file, dataset and test hash is replaced
    in place and keeps its ``evaluation_id``.

    Args:
        store: The tracking server's SQL store.
        run_id: Run that owns the evaluated model file.
        record: Complete evaluation identity, metrics and parameters.

    Returns:
        The current evaluation, whether it was created, and the write action.

    Raises:
        MlflowException: If the dataset identity or payload is invalid.
    """
    fields = _validate_record(record)
    store.get_run(run_id)
    dataset_hash = fields.pop("dataset_hash")
    released = validate_dataset_test(
        store, fields["dataset_name"], fields["dataset_version"], dataset_hash
    )
    validate_metrics(released, record["metrics"])
    evidence = {
        "source": "dataset_release" if released["git_commit"] else "dataset_history",
        "name": released["name"],
        "version": released["version"],
    }
    fields["metadata_json"] = _validate_json(
        {"dataset_identity": evidence}, "dataset identity"
    )
    with _session(store) as session:
        if store.engine.dialect.name == "sqlite":
            # SQLite ignores row locks; serialize before finding an equal-content version.
            session.execute(sqlalchemy.text("BEGIN IMMEDIATE"))
        else:
            session.execute(
                sqlalchemy.select(SqlRun.run_uuid)
                .where(SqlRun.run_uuid == run_id)
                .with_for_update()
            ).scalar_one()
        try:
            return _write_evaluation(session, run_id, fields, dataset_hash)
        except sqlalchemy.exc.IntegrityError:
            return _write_evaluation(session, run_id, fields, dataset_hash)


def list_evaluations(store: SqlAlchemyStore, run_id: str) -> list[dict[str, Any]]:
    """Return a run's evaluations, newest known evaluation time first.

    Args:
        store: The tracking server's SQL store.
        run_id: Owning run identifier.

    Returns:
        Evaluation records, including imports with explicitly missing fields.
    """
    store.get_run(run_id)
    with _session(store) as session:
        query = (
            sqlalchemy.select(SqlEvaluation)
            .where(SqlEvaluation.run_id == run_id)
            .order_by(
                sqlalchemy.case((SqlEvaluation.evaluation_time.is_(None), 1), else_=0),
                SqlEvaluation.evaluation_time.desc(),
                SqlEvaluation.created_at.desc(),
                SqlEvaluation.evaluation_id,
            )
        )
        return [row.to_dict() for row in session.execute(query).scalars()]


def get_evaluation(store: SqlAlchemyStore, evaluation_id: str) -> dict[str, Any] | None:
    """Return one evaluation, or ``None`` when its identifier is unknown.

    Args:
        store: The tracking server's SQL store.
        evaluation_id: Identifier returned when the evaluation was recorded.

    Returns:
        The evaluation record, or ``None``.
    """
    with _session(store) as session:
        row = session.get(SqlEvaluation, evaluation_id)
        return row.to_dict() if row is not None else None
