"""Benchmark evaluation records stored beside MLflow's tracking tables.

Sections: Tables, Validation, Records. Each evaluation owns its result and
provenance snapshot; run artifacts remain owned by MLflow's artifact store.
Historical imports keep the original row and refuse conflicting replacements.

Naming table: ``validate_*`` checks input, ``create_*`` inserts, ``get_*`` reads
one record, and ``list_*`` reads a collection.
"""

from __future__ import annotations

import hashlib
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
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import aliased, declarative_base

from mlflow.deeplore import dataset_registry
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE, RESOURCE_CONFLICT
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
    """Own one immutable evaluation and its migration provenance.

    Dataset identities are validated against the dataset catalog. Checkpoint
    bytes and detailed reports remain in the associated run's artifact store.
    """

    __tablename__ = "deeplore_evaluations"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "source_artifact", "source_row", name="evaluation_source_key"
        ),
        Index("index_deeplore_evaluations_run_time", "run_id", "evaluated_at"),
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
    test_hash = Column(String(256))
    ckpt_path = Column(String(1024))
    ckpt_hash = Column(String(256))
    ckpt_hash_algorithm = Column(String(64))
    evaluated_at = Column(BigInteger)
    metrics_json = Column(Text, nullable=False)
    artifact_path = Column(String(1024))
    source_artifact = Column(String(1024))
    source_row = Column(Integer)
    source_digest = Column(String(64))
    metadata_json = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False)

    # ---- Serialization ----

    def to_dict(self) -> dict[str, Any]:
        """Return the stored result and provenance as JSON-compatible values."""
        return {
            "evaluation_id": self.evaluation_id,
            "run_id": self.run_id,
            "dataset_name": self.dataset_name,
            "dataset_version": self.dataset_version,
            "association_status": self.association_status,
            "benchmark_name": self.benchmark_name,
            "test_hash": self.test_hash,
            "ckpt_path": self.ckpt_path,
            "ckpt_hash": self.ckpt_hash,
            "ckpt_hash_algorithm": self.ckpt_hash_algorithm,
            "evaluated_at": self.evaluated_at,
            "metrics": json.loads(self.metrics_json),
            "artifact_path": self.artifact_path,
            "source_artifact": self.source_artifact,
            "source_row": self.source_row,
            "source_digest": self.source_digest,
            "metadata": json.loads(self.metadata_json),
            "created_at": self.created_at,
        }


def _session(store: SqlAlchemyStore) -> AbstractContextManager[Session]:
    with _initialization_lock:
        if store.engine not in _initialized_engines:
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


def _validate_record(record: dict[str, Any], allow_incomplete: bool) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise _invalid("evaluation must be a JSON object")
    fields: dict[str, Any] = {}
    for key, limit in (("dataset_name", 256), ("dataset_version", 64)):
        fields[key] = _validate_text(record, key, limit, not allow_incomplete)
    fields["association_status"] = (
        "confirmed"
        if fields["dataset_name"] and fields["dataset_version"]
        else "pending"
    )
    fields["benchmark_name"] = _validate_text(record, "benchmark_name", 256, True)
    for key in ("test_hash", "ckpt_hash"):
        fields[key] = _validate_text(record, key, 256, not allow_incomplete)
    test_hash = fields["test_hash"]
    if (
        test_hash is not None
        and re.fullmatch(r"(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{64})(?:\.dir)?", test_hash)
        is None
    ):
        raise _invalid(
            "test_hash must be a 32- or 64-character hexadecimal digest, optionally .dir"
        )
    fields["ckpt_hash_algorithm"] = _validate_text(
        record, "ckpt_hash_algorithm", 64, not allow_incomplete
    )
    algorithm = fields["ckpt_hash_algorithm"]
    checkpoint_hash = fields["ckpt_hash"]
    if algorithm is not None and algorithm not in ("md5", "sha256"):
        raise _invalid("ckpt_hash_algorithm must be md5 or sha256")
    if algorithm is not None and checkpoint_hash is not None:
        length = 32 if algorithm == "md5" else 64
        if (
            len(checkpoint_hash) != length
            or re.fullmatch("[0-9a-fA-F]+", checkpoint_hash) is None
        ):
            raise _invalid(
                f"ckpt_hash must be a {length}-character hexadecimal {algorithm} digest"
            )
    elif checkpoint_hash is not None and (
        len(checkpoint_hash) not in (32, 64)
        or re.fullmatch("[0-9a-fA-F]+", checkpoint_hash) is None
    ):
        raise _invalid(
            "historical ckpt_hash must be a 32- or 64-character hexadecimal digest"
        )
    fields["ckpt_path"] = _validate_text(
        record, "ckpt_path", 1024, not allow_incomplete
    )
    for key in ("artifact_path", "source_artifact"):
        fields[key] = _validate_text(record, key, 1024, False)
    for key in ("ckpt_path", "artifact_path", "source_artifact"):
        _validate_artifact_path(fields[key], key)

    evaluated_at = record.get("evaluated_at")
    if evaluated_at is not None and (type(evaluated_at) is not int or evaluated_at < 0):
        raise _invalid(
            "evaluated_at must be a nonnegative Unix timestamp in milliseconds"
        )
    if evaluated_at is None and not allow_incomplete:
        raise _invalid("evaluated_at is required")
    fields["evaluated_at"] = evaluated_at

    metrics = record.get("metrics")
    if not isinstance(metrics, dict) or not metrics:
        raise _invalid("metrics must be a nonempty JSON object")
    for key, value in metrics.items():
        if not isinstance(key, str) or not key:
            raise _invalid("metric names must be nonempty strings")
        if value is None and allow_incomplete:
            continue
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise _invalid(f"metric {key!r} must be a finite number")
    fields["metrics_json"] = _validate_json(metrics, "metrics")

    metadata = record.get("metadata", {})
    if not isinstance(metadata, dict):
        raise _invalid("metadata must be a JSON object")
    fields["metadata_json"] = _validate_json(metadata, "metadata")
    fields["source_row"] = record.get("source_row")
    fields["source_digest"] = None
    if fields["source_artifact"] is not None or fields["source_row"] is not None:
        if fields["source_artifact"] is None or type(fields["source_row"]) is not int:
            raise _invalid(
                "source_artifact and an integer source_row must be supplied together"
            )
        if fields["source_row"] < 0:
            raise _invalid("source_row must be a zero-based nonnegative row index")
        if not isinstance(metadata.get("original_record"), dict):
            raise _invalid("imported evaluations require metadata.original_record")
        original = _validate_json(
            metadata["original_record"], "metadata.original_record"
        )
        fields["source_digest"] = hashlib.sha256(original.encode("utf-8")).hexdigest()
    if allow_incomplete:
        if fields["source_digest"] is None:
            raise _invalid(
                "historical imports require source_artifact, source_row and original_record"
            )
        reasons = metadata.get("incomplete_reasons", {})
        for key in (
            "dataset_name",
            "dataset_version",
            "test_hash",
            "ckpt_hash",
            "ckpt_path",
            "evaluated_at",
        ):
            if fields[key] is None and (
                not isinstance(reasons, dict)
                or not isinstance(reasons.get(key), str)
                or not reasons[key].strip()
            ):
                raise _invalid(
                    f"missing historical {key} requires metadata.incomplete_reasons.{key}"
                )
    return fields


# ===== Records =====


def _get_existing_source(
    session: Session, run_id: str, fields: dict[str, Any]
) -> SqlEvaluation | None:
    if fields["source_digest"] is None:
        return None
    return session.execute(
        sqlalchemy.select(SqlEvaluation).where(
            SqlEvaluation.run_id == run_id,
            SqlEvaluation.source_artifact == fields["source_artifact"],
            SqlEvaluation.source_row == fields["source_row"],
        )
    ).scalar_one_or_none()


def _validate_existing_source(
    row: SqlEvaluation, fields: dict[str, Any]
) -> dict[str, Any]:
    if row.source_digest != fields["source_digest"]:
        raise MlflowException(
            "the source artifact row was already imported with different content; "
            "the stored evaluation was preserved",
            error_code=RESOURCE_CONFLICT,
        )
    return row.to_dict()


def create_evaluation(
    store: SqlAlchemyStore,
    run_id: str,
    record: dict[str, Any],
    *,
    allow_incomplete: bool = False,
) -> tuple[dict[str, Any], bool]:
    """Record an evaluation, retaining each historical source row exactly once.

    Args:
        store: The tracking server's SQL store.
        run_id: Run that owns the evaluated checkpoint and reports.
        record: Evaluation identity, metrics and provenance fields.
        allow_incomplete: Permit documented missing fields in historical imports.

    Returns:
        The persisted evaluation and whether this call inserted it.

    Raises:
        MlflowException: If the run, dataset identity or payload is invalid, or
            an imported source row conflicts with an earlier import.
    """
    fields = _validate_record(record, allow_incomplete)
    store.get_run(run_id)
    if fields["association_status"] == "confirmed":
        evidence = validate_dataset_version(
            store, fields["dataset_name"], fields["dataset_version"]
        )
    else:
        evidence = {
            "source": "unresolved",
            "name": fields["dataset_name"],
            "version": fields["dataset_version"],
        }
    metadata = json.loads(fields["metadata_json"])
    metadata["dataset_identity"] = evidence
    fields["metadata_json"] = _validate_json(metadata, "metadata")
    with _session(store) as session:
        existing = _get_existing_source(session, run_id, fields)
        if existing is not None:
            return _validate_existing_source(existing, fields), False
        row = SqlEvaluation(
            evaluation_id=uuid.uuid4().hex,
            run_id=run_id,
            created_at=int(time.time() * 1000),
            **fields,
        )
        try:
            with session.begin_nested():
                session.add(row)
                session.flush()
        except sqlalchemy.exc.IntegrityError:
            existing = _get_existing_source(session, run_id, fields)
            if existing is None:
                raise
            return _validate_existing_source(existing, fields), False
        return row.to_dict(), True


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
