"""Benchmark evaluation records stored beside MLflow's tracking tables.

Sections: Tables, Validation, Records. Each evaluation owns its metrics and
parameters; checkpoint artifacts remain owned by MLflow's artifact store.
Each run has one current result for each dataset name and known test hash.
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
from sqlalchemy.orm import aliased, declarative_base, relationship

from mlflow.deeplore import dataset_registry
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE
from mlflow.store.tracking.dbmodels.models import (
    SqlDataset,
    SqlInput,
    SqlInputTag,
    SqlRun,
)

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
    """Own one current evaluation and its dataset identity.

    Dataset identities are validated against the dataset catalog. Checkpoint
    bytes remain in the associated run's artifact store.
    """

    __tablename__ = "deeplore_evaluations"
    __table_args__ = (
        Index("index_deeplore_evaluations_run_time", "run_id", "evaluation_time"),
        Index(
            "index_deeplore_evaluations_run_dataset_version",
            "run_id",
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
    # Keep API attributes stable while storage names match the evaluation card.
    ckpt_path = Column("checkpoint_path", String(1024))
    ckpt_hash = Column("checkpoint_hash", String(32))
    evaluated_at = Column("evaluation_time", BigInteger)
    metrics_json = Column("metrics", Text, nullable=False)
    params_json = Column("params", Text, nullable=False)
    metadata_json = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    dataset_version_record = relationship(
        dataset_registry.SqlDatasetVersion, lazy="joined"
    )

    # ---- Serialization ----

    @property
    def test_hash(self) -> str | None:
        """Return test content from the associated immutable dataset version."""
        if self.dataset_version_record is None:
            return None
        content_hash = json.loads(self.dataset_version_record.hashes).get("test")
        return content_hash.lower() if isinstance(content_hash, str) else None

    def to_dict(self) -> dict[str, Any]:
        """Return the evaluation without internal dataset evidence."""
        return {
            "evaluation_id": self.evaluation_id,
            "run_id": self.run_id,
            "dataset_name": self.dataset_name,
            "dataset_version": self.dataset_version,
            "association_status": self.association_status,
            "benchmark_name": self.dataset_name or self.benchmark_name,
            "test_hash": self.test_hash,
            "ckpt_path": self.ckpt_path,
            "ckpt_hash": self.ckpt_hash,
            "evaluated_at": self.evaluated_at,
            "metrics": json.loads(self.metrics_json),
            "params": json.loads(self.params_json),
            "created_at": self.created_at,
        }


def _session(store: SqlAlchemyStore) -> AbstractContextManager[Session]:
    with _initialization_lock:
        if store.engine not in _initialized_engines:
            with dataset_registry._session(store):
                pass
            _Base.metadata.create_all(store.engine, checkfirst=True)
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


def validate_dataset_version(
    store: SqlAlchemyStore, name: str, version: str
) -> dict[str, Any]:
    """Require a currently known or historically recorded dataset identity.

    Args:
        store: The tracking server's SQL store.
        name: Exact dataset name.
        version: Exact version of that dataset.

    Returns:
        Evidence identifying the catalog or historical input that matched.

    Raises:
        MlflowException: If the name and version cannot be verified.
    """
    versions = dataset_registry.list_dataset_versions(store, name)
    if any(row["version"] == version for row in versions):
        return {"source": "dataset_release", "name": name, "version": version}
    changes = dataset_registry.list_dataset_changelogs(store).get(name, [])
    if any(version in change for change in changes):
        return {"source": "dataset_changelog", "name": name, "version": version}

    # Native dataset inputs preserve historical identities, including deleted runs.
    with _session(store) as session:
        context = aliased(SqlInputTag)
        evaluation_context = sqlalchemy.exists().where(
            context.input_uuid == SqlInput.input_uuid,
            context.name == "mlflow.data.context",
            context.value == "evaluation",
        )
        native = session.execute(
            sqlalchemy.select(SqlDataset.dataset_uuid, SqlInput.destination_id)
            .join(SqlInput, SqlInput.source_id == SqlDataset.dataset_uuid)
            .join(SqlInputTag, SqlInputTag.input_uuid == SqlInput.input_uuid)
            .where(
                SqlDataset.name == name,
                SqlInput.source_type == "DATASET",
                SqlInput.destination_type == "RUN",
                sqlalchemy.or_(
                    SqlInputTag.name == "version",
                    sqlalchemy.and_(
                        SqlInputTag.name == "test_version", evaluation_context
                    ),
                ),
                SqlInputTag.value == version,
            )
            .order_by(SqlDataset.dataset_uuid, SqlInput.destination_id)
            .limit(1)
        ).first()
        if native is not None:
            return {
                "source": "mlflow_dataset_input",
                "name": name,
                "version": version,
                "dataset_id": native.dataset_uuid,
                "run_id": native.destination_id,
            }
        previous = session.execute(
            sqlalchemy.select(SqlEvaluation)
            .where(
                SqlEvaluation.dataset_name == name,
                SqlEvaluation.dataset_version == version,
                SqlEvaluation.association_status == "confirmed",
            )
            .limit(1)
        ).scalar_one_or_none()
        if previous is not None:
            evidence = json.loads(previous.metadata_json).get("dataset_identity")
            if evidence:
                return evidence

    # The dataset module owns metadata access and its interpretation.
    from mlflow.deeplore.dataset_api import build_dataset_summary, find_dataset
    from mlflow.deeplore.dataset_release import parse_changelog

    try:
        dataset = find_dataset(name)
    except MlflowException as error:
        if error.error_code != "RESOURCE_DOES_NOT_EXIST":
            raise
        raise _invalid(f"unknown dataset name/version: {name!r} {version!r}") from error
    summary = build_dataset_summary(dataset, [])
    metadata = summary.get("metadata") or {}
    try:
        changes = parse_changelog(metadata.get("changelog"))
    except ValueError as error:
        raise _invalid(f"dataset {name!r} has an invalid changelog: {error}") from error
    if version != metadata.get("version") and version not in changes:
        raise _invalid(f"unknown dataset name/version: {name!r} {version!r}")
    if changes:
        dataset_registry.register_dataset_changelog(
            store, name, [{key: value} for key, value in changes.items()]
        )
    return {
        "source": (
            "dataset_current"
            if version == metadata.get("version")
            else "dataset_changelog"
        ),
        "name": name,
        "version": version,
    }


def validate_dataset_test(
    store: SqlAlchemyStore,
    name: str,
    version: str,
    test_hash: str | None,
) -> dict[str, Any]:
    """Verify that a dataset version used the requested test content hash.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name.
        version: Dataset version.
        test_hash: Optional observed hash to verify against the dataset version.

    Returns:
        Server-owned evidence for the matching identity and test content.

    Raises:
        MlflowException: If no current or historical evidence matches all fields.
    """
    validate_dataset_version(store, name, version)
    for released in dataset_registry.list_dataset_versions(store, name):
        if released["version"] != version:
            continue
        content_hash = released["hashes"].get("test")
        if (
            not isinstance(content_hash, str)
            or re.fullmatch(r"[0-9a-fA-F]{32}(?:\.dir)?", content_hash) is None
        ):
            raise _invalid(
                f"dataset {name!r} {version!r} has no registered test content"
            )
        if test_hash is not None and content_hash.lower() != test_hash:
            raise _invalid(
                "test_hash does not match the registered test content for "
                f"dataset {name!r} {version!r}: expected {content_hash.lower()!r}"
            )
        return {
            "source": (
                "dataset_release" if released["git_commit"] else "dataset_history"
            ),
            "name": name,
            "version": version,
            "test_hash": content_hash.lower(),
        }
    if test_hash is None:
        raise _invalid(
            "dataset version must have registered test content before evaluation"
        )
    with _session(store) as session:
        context = aliased(SqlInputTag)
        split = aliased(SqlInputTag)
        native = session.execute(
            sqlalchemy.select(SqlDataset.dataset_uuid, SqlInput.destination_id)
            .join(SqlInput, SqlInput.source_id == SqlDataset.dataset_uuid)
            .join(SqlInputTag, SqlInputTag.input_uuid == SqlInput.input_uuid)
            .join(context, context.input_uuid == SqlInput.input_uuid)
            .join(split, split.input_uuid == SqlInput.input_uuid)
            .where(
                SqlDataset.name == name,
                SqlInput.source_type == "DATASET",
                SqlInput.destination_type == "RUN",
                SqlInputTag.name.in_(("version", "test_version")),
                SqlInputTag.value == version,
                context.name == "mlflow.data.context",
                context.value == "evaluation",
                split.name == "split_md5",
                sqlalchemy.func.lower(split.value) == test_hash,
            )
            .order_by(SqlDataset.dataset_uuid, SqlInput.destination_id)
            .limit(1)
        ).first()
    if native is not None:
        dataset_registry.register_historical_dataset_version(
            store, name, version, test_hash
        )
        return {
            "source": "mlflow_dataset_input",
            "name": name,
            "version": version,
            "test_hash": test_hash,
            "dataset_id": native.dataset_uuid,
            "run_id": native.destination_id,
        }

    from mlflow.deeplore.dataset_api import build_dataset_summary, find_dataset
    from mlflow.deeplore.dataset_release import parse_hashes

    try:
        metadata = build_dataset_summary(find_dataset(name), []).get("metadata") or {}
    except MlflowException as error:
        if error.error_code != "RESOURCE_DOES_NOT_EXIST":
            raise
        metadata = {}
    content_hash = parse_hashes(metadata).get("test")
    if (
        metadata.get("version") == version
        and isinstance(content_hash, str)
        and content_hash.lower() == test_hash
    ):
        dataset_registry.register_historical_dataset_version(
            store, name, version, test_hash
        )
        return {
            "source": "dataset_current",
            "name": name,
            "version": version,
            "test_hash": test_hash,
        }
    raise _invalid(
        f"test_hash does not match known test content for dataset {name!r} {version!r}"
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
        ("test_hash", r"[0-9a-fA-F]{32}(?:\.dir)?", 36),
        ("ckpt_hash", r"[0-9a-fA-F]{32}", 32),
    ):
        value = _validate_text(record, key, limit, key != "test_hash")
        if value is None:
            fields[key] = None
            continue
        if re.fullmatch(pattern, value) is None:
            suffix = ", optionally .dir" if key == "test_hash" else ""
            raise _invalid(f"{key} must be a complete hexadecimal MD5 digest{suffix}")
        fields[key] = value.lower()
    fields["ckpt_path"] = _validate_text(record, "ckpt_path", 1024, True)
    _validate_artifact_path(fields["ckpt_path"], "ckpt_path")

    evaluated_at = record.get("evaluated_at")
    if evaluated_at is not None and (type(evaluated_at) is not int or evaluated_at < 0):
        raise _invalid(
            "evaluated_at must be a nonnegative Unix timestamp in milliseconds"
        )
    if evaluated_at is None:
        raise _invalid("evaluated_at is required")
    fields["evaluated_at"] = evaluated_at

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
    session: Session, run_id: str, fields: dict[str, Any], test_hash: str
) -> SqlEvaluation | None:
    versions = session.execute(
        sqlalchemy.select(dataset_registry.SqlDatasetVersion).where(
            dataset_registry.SqlDatasetVersion.name == fields["dataset_name"]
        )
    ).scalars()
    matching_versions = [
        row.version
        for row in versions
        if (json.loads(row.hashes).get("test") or "").lower() == test_hash
    ]
    return session.execute(
        sqlalchemy.select(SqlEvaluation)
        .where(
            SqlEvaluation.run_id == run_id,
            SqlEvaluation.dataset_name == fields["dataset_name"],
            SqlEvaluation.dataset_version.in_(matching_versions),
        )
        .with_for_update(of=SqlEvaluation)
    ).scalar_one_or_none()


def _write_evaluation(
    session: Session, run_id: str, fields: dict[str, Any], test_hash: str
) -> tuple[dict[str, Any], bool, str]:
    with session.begin_nested():
        row = _get_matching_evaluation(session, run_id, fields, test_hash)
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
    """Replace a run's result for one dataset test hash while preserving its identity.

    Args:
        store: The tracking server's SQL store.
        run_id: Run that owns the evaluated checkpoint.
        record: Complete evaluation identity, metrics and parameters.

    Returns:
        The current evaluation, whether it was created, and the write action.

    Raises:
        MlflowException: If the dataset identity or payload is invalid.
    """
    fields = _validate_record(record)
    store.get_run(run_id)
    evidence = validate_dataset_test(
        store,
        fields["dataset_name"],
        fields["dataset_version"],
        fields.pop("test_hash"),
    )
    test_hash = evidence.pop("test_hash")
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
            return _write_evaluation(session, run_id, fields, test_hash)
        except sqlalchemy.exc.IntegrityError:
            return _write_evaluation(session, run_id, fields, test_hash)


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
                sqlalchemy.case((SqlEvaluation.evaluated_at.is_(None), 1), else_=0),
                SqlEvaluation.evaluated_at.desc(),
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
