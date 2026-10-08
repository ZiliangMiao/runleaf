"""Datasets, their versions and release jobs, stored in the tracking database.

Four tables live beside MLflow's own in the same database. They are created on
first use and are NOT part of MLflow's Alembic history, so the schema revision
MLflow verifies at startup is untouched and stock MLflow tooling keeps working
against the database. Columns added after a table first shipped are appended
in place on first use.

- ``deeplore_datasets``: one row per dataset, holding its repository and
  whether it is archived. A name stays taken for good.
- ``deeplore_dataset_versions``: one row per known ``(name, version)``,
  including historical identities without a complete release snapshot.
- ``deeplore_dataset_changelog``: historical changes, including versions that
  predate the release workflow and have no verified release snapshot.
- ``deeplore_dataset_release_jobs``: one row per check or release started from
  the UI, updated by the background worker so any server worker can report it.

Every function takes the tracking server's ``SqlAlchemyStore`` and uses its
engine and managed sessions.

Sections:
- Tables: dataset, release, changelog and job records.
- Datasets: create, archive and delete datasets.
- Changelog: persist and list historical changes without inventing releases.
- Versions: register and list released versions.
- Jobs: create, update and read release jobs.

Verb paradigm: ``create_*`` / ``update_*`` / ``register_*`` / ``delete_*`` write,
``get_*`` returns one row or ``None``, ``list_*`` returns many; all return plain
dicts.
"""

import json
import time
import uuid
from typing import Any, Optional

import sqlalchemy
from sqlalchemy import BigInteger, Boolean, Column, Integer, String, Text
from sqlalchemy.orm import declarative_base

from mlflow.deeplore.dataset_release import (
    build_metadata,
    parse_changelog,
    parse_version,
)
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE, RESOURCE_ALREADY_EXISTS

# ===== Tables =====

_Base = declarative_base()

JOB_PENDING = "pending"
JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"
JOB_ACTIVE: tuple[str, ...] = (JOB_PENDING, JOB_RUNNING)


class SqlDatasetEntry(_Base):
    """One dataset known to MLflow, released or not.

    Owns the name reservation, the repository that holds the dataset and the
    archived flag. It does not own versions, which are ``SqlDatasetVersion`` rows.
    """

    __tablename__ = "deeplore_datasets"

    name = Column(String(256), primary_key=True)
    # Server-side repository root; null when registered without one.
    repo = Column(String(1024))
    archived = Column(Boolean, nullable=False, default=False)
    created_at = Column(BigInteger, nullable=False)

    def to_dict(self) -> dict:
        """Return the row as a JSON-ready dict."""
        return {
            "name": self.name,
            "repo": self.repo,
            "archived": bool(self.archived),
            "created_at": self.created_at,
        }


class SqlDatasetVersion(_Base):
    """One immutable dataset version with any available release provenance.

    Owns the released metadata snapshot and its git coordinates. It does not
    own the dataset's files or any link to MLflow runs.
    """

    __tablename__ = "deeplore_dataset_versions"

    name = Column(String(256), primary_key=True)
    version = Column(String(64), primary_key=True)
    change = Column(Text)
    # JSON: split name -> directory hash or null.
    hashes = Column(Text, nullable=False)
    # JSON: metadata.yaml as committed under the release tag.
    metadata_json = Column(Text, nullable=False)
    git_repo = Column(String(1024))
    git_tag = Column(String(512))
    git_commit = Column(String(64))
    # System user that ran the release; null for versions that predate the field.
    released_by = Column(String(256))
    # Registration time, which is the release time.
    created_at = Column(BigInteger, nullable=False)

    def to_dict(self) -> dict:
        """Return the row as a JSON-ready dict."""
        return {
            "name": self.name,
            "version": self.version,
            "change": self.change,
            "hashes": json.loads(self.hashes),
            "metadata": json.loads(self.metadata_json),
            "git_repo": self.git_repo,
            "git_tag": self.git_tag,
            "git_commit": self.git_commit,
            "released_by": self.released_by,
            "created_at": self.created_at,
        }


class SqlDatasetReleaseJob(_Base):
    """One check or release run started from the UI.

    Owns the run's progress as reported by its worker process. It does not
    own the release outcome, which is the ``deeplore_dataset_versions`` row.
    """

    __tablename__ = "deeplore_dataset_release_jobs"

    job_id = Column(String(32), primary_key=True)
    repo = Column(String(1024), nullable=False)
    name = Column(String(256), nullable=False)
    version = Column(String(64), nullable=False)
    change = Column(Text, nullable=False)
    # JSON: list of units to delete with this release; null means none.
    deletions = Column(Text)
    dry_run = Column(Boolean, nullable=False)
    status = Column(String(16), nullable=False)
    pid = Column(Integer)
    # JSON: step number -> running / done / failed / skipped.
    steps = Column(Text, nullable=False)
    # JSON: list of {level, check, message}.
    findings = Column(Text, nullable=False)
    log = Column(Text, nullable=False)
    error = Column(Text)
    created_at = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)

    def to_dict(self) -> dict:
        """Return the row as a JSON-ready dict."""
        return {
            "job_id": self.job_id,
            "repo": self.repo,
            "name": self.name,
            "version": self.version,
            "change": self.change,
            "deletions": json.loads(self.deletions or "[]"),
            "dry_run": self.dry_run,
            "status": self.status,
            "pid": self.pid,
            "steps": json.loads(self.steps),
            "findings": json.loads(self.findings),
            "log": self.log,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class SqlDatasetChangelog(_Base):
    """One historical change, independent of a verified release snapshot.

    Owns only the dataset name, version and change text. Git coordinates and
    split hashes belong exclusively to released version records.
    """

    __tablename__ = "deeplore_dataset_changelog"

    name = Column(String(256), primary_key=True)
    version = Column(String(64), primary_key=True)
    change = Column(Text, nullable=False)


_initialized_engines: set[int] = set()
# Columns added after their table first shipped: table -> column -> DDL type.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "deeplore_dataset_versions": {"released_by": "VARCHAR(256)"},
    "deeplore_dataset_release_jobs": {"deletions": "TEXT"},
}


def _ensure_columns(engine: Any) -> None:
    """Append the columns a table created by an earlier revision lacks."""
    inspector = sqlalchemy.inspect(engine)
    for table, columns in _ADDED_COLUMNS.items():
        existing = {column["name"] for column in inspector.get_columns(table)}
        for name, ddl_type in columns.items():
            if name in existing:
                continue
            try:
                with engine.begin() as connection:
                    connection.execute(
                        sqlalchemy.text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl_type}")
                    )
            except sqlalchemy.exc.OperationalError:
                # Another server worker added the column first.
                pass


def _session(store: Any) -> Any:
    """Open a managed session, creating the tables on first use per engine."""
    if id(store.engine) not in _initialized_engines:
        _Base.metadata.create_all(store.engine, checkfirst=True)
        _ensure_columns(store.engine)
        _initialized_engines.add(id(store.engine))
    return store.ManagedSessionMaker()


def _now_ms() -> int:
    return int(time.time() * 1000)


# ===== Datasets =====


def create_dataset(store: Any, name: str, repo: Optional[str]) -> dict:
    """Register a dataset, taking its name for good.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name.
        repo: Server-side repository root that holds the dataset, if known.

    Returns:
        The new dataset row.

    Raises:
        MlflowException: If the name is already taken, archived datasets included.
    """
    with _session(store) as session:
        taken = session.get(SqlDatasetEntry, name) or session.execute(
            sqlalchemy.select(SqlDatasetVersion).where(SqlDatasetVersion.name == name).limit(1)
        ).first()
        if taken is not None:
            raise MlflowException(
                f"dataset {name!r} already exists", error_code=RESOURCE_ALREADY_EXISTS
            )
        row = SqlDatasetEntry(name=name, repo=repo, archived=False, created_at=_now_ms())
        session.add(row)
        session.flush()
        return row.to_dict()


def list_datasets(store: Any) -> dict[str, dict]:
    """Return every registered dataset row, keyed by name."""
    with _session(store) as session:
        rows = session.execute(sqlalchemy.select(SqlDatasetEntry)).scalars()
        return {row.name: row.to_dict() for row in rows}


def get_dataset(store: Any, name: str) -> Optional[dict]:
    """Return one dataset row, or ``None`` if the name has no row."""
    with _session(store) as session:
        row = session.get(SqlDatasetEntry, name)
        return row.to_dict() if row is not None else None


def update_dataset_archived(
    store: Any, name: str, archived: bool, repo: Optional[str] = None
) -> dict:
    """Set a dataset's archived flag.

    A dataset released before this table existed has versions but no row; the
    row is created here so the flag has a home.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name.
        archived: The new flag.
        repo: Repository root to remember, needed to restore an archived dataset.

    Returns:
        The updated dataset row.
    """
    with _session(store) as session:
        row = session.get(SqlDatasetEntry, name)
        if row is None:
            row = SqlDatasetEntry(name=name, repo=None, created_at=_now_ms())
            session.add(row)
        row.archived = archived
        row.repo = repo or row.repo
        session.flush()
        return row.to_dict()


def delete_dataset(store: Any, name: str) -> None:
    """Remove a dataset that was never released, freeing its name.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name.

    Raises:
        MlflowException: If the dataset has versions; those are only archived.
    """
    with _session(store) as session:
        released = session.execute(
            sqlalchemy.select(SqlDatasetVersion).where(SqlDatasetVersion.name == name).limit(1)
        ).first()
        if released is not None:
            raise MlflowException(
                f"dataset {name!r} has released versions; archive it instead",
                error_code=INVALID_PARAMETER_VALUE,
            )
        for table in (SqlDatasetChangelog, SqlDatasetEntry):
            session.execute(sqlalchemy.delete(table).where(table.name == name))


# ===== Changelog =====


def _register_changelog(session: Any, name: str, changes: dict[str, str]) -> None:
    for version, change in changes.items():
        row = session.get(SqlDatasetChangelog, (name, version))
        if row is None:
            session.add(SqlDatasetChangelog(name=name, version=version, change=change))
        else:
            row.change = change


def register_dataset_changelog(store: Any, name: str, changelog: list[dict[str, str]]) -> None:
    """Persist historical changes without registering unverified releases.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name.
        changelog: Version-to-change mappings from the dataset metadata.

    Raises:
        ValueError: If a version or its change text is invalid or conflicting.
    """
    changes = parse_changelog(changelog)
    with _session(store) as session:
        _register_changelog(session, name, changes)


def list_dataset_changelogs(store: Any) -> dict[str, list[dict[str, str]]]:
    """Return persisted changes by dataset, in ascending semantic version order.

    Args:
        store: The tracking server's SQL store.

    Returns:
        Dataset names mapped to metadata-compatible changelog lists.
    """
    with _session(store) as session:
        rows = session.execute(sqlalchemy.select(SqlDatasetChangelog)).scalars().all()
        changes: dict[str, list[dict[str, str]]] = {}
        for row in sorted(rows, key=lambda row: (row.name, parse_version(row.version))):
            changes.setdefault(row.name, []).append({row.version: row.change})
        return changes


# ===== Versions =====


def register_historical_dataset_version(
    store: Any, name: str, version: str, test_hash: str
) -> dict[str, Any]:
    """Persist a verified historical identity without inventing release details.

    Args:
        store: The tracking server's SQL store.
        name: Dataset name from historical input evidence.
        version: Exact historical version string.
        test_hash: Complete verified test content hash.

    Returns:
        The existing or newly registered dataset version.

    Raises:
        MlflowException: If the identity conflicts with a known version.
    """
    with _session(store) as session:
        if store.engine.dialect.name == "sqlite":
            session.execute(sqlalchemy.text("BEGIN IMMEDIATE"))
        row = session.get(SqlDatasetVersion, (name, version))
        if row is None:
            row = SqlDatasetVersion(
                name=name,
                version=version,
                hashes=json.dumps({"test": test_hash.lower()}),
                metadata_json="{}",
                created_at=_now_ms(),
            )
            session.add(row)
        elif (json.loads(row.hashes).get("test") or "").lower() != test_hash.lower():
            raise MlflowException(
                f"dataset {name!r} {version!r} has different immutable test content",
                error_code=INVALID_PARAMETER_VALUE,
            )
        session.flush()
        return row.to_dict()


def register_dataset_version(store: Any, record: dict) -> dict:
    """Register one released version; a released version is never changed.

    A historical identity, known only by its hashes, may be completed once by
    the release that carries the same hashes.

    Args:
        store: The tracking server's SQL store.
        record: ``name``, ``version``, ``change``, ``hashes``, ``metadata``,
            ``git_repo``, ``git_tag`` and ``git_commit``, optionally ``released_by``.

    Returns:
        The stored row.

    Raises:
        MlflowException: If a required field is missing or malformed, the
            ``(name, version)`` is already released, or its hashes conflict
            with a known historical identity.
    """
    required = (
        "name",
        "version",
        "change",
        "hashes",
        "metadata",
        "git_repo",
        "git_tag",
        "git_commit",
    )
    missing = [key for key in required if record.get(key) in (None, "")]
    if missing:
        raise MlflowException(
            f"dataset version record misses field(s): {', '.join(missing)}",
            error_code=INVALID_PARAMETER_VALUE,
        )
    if not isinstance(record["metadata"], dict):
        raise MlflowException("metadata must be a mapping", error_code=INVALID_PARAMETER_VALUE)
    metadata = build_metadata(record["metadata"])
    try:
        parse_version(record["version"])
        changes = parse_changelog(metadata.get("changelog"))
    except ValueError as error:
        raise MlflowException(str(error), error_code=INVALID_PARAMETER_VALUE) from error
    with _session(store) as session:
        if store.engine.dialect.name == "sqlite":
            # Serialize enrichment so an established split hash cannot be replaced.
            session.execute(sqlalchemy.text("BEGIN IMMEDIATE"))
        row = session.get(
            SqlDatasetVersion, (record["name"], record["version"]), with_for_update=True
        )
        if row is None:
            row = SqlDatasetVersion(
                name=record["name"], version=record["version"], created_at=_now_ms()
            )
            session.add(row)
        elif row.git_commit is not None:
            raise MlflowException(
                f"{row.name} {row.version} is already registered; a released version "
                "cannot be changed",
                error_code=RESOURCE_ALREADY_EXISTS,
            )
        else:
            previous_hashes = json.loads(row.hashes)
            incoming_hashes = record["hashes"]
            protected_splits = {split for split, digest in previous_hashes.items() if digest}
            for split in protected_splits:
                if (previous_hashes.get(split) or "").lower() != (
                    incoming_hashes.get(split) or ""
                ).lower():
                    raise MlflowException(
                        f"dataset {row.name!r} {row.version!r} has immutable {split} content",
                        error_code=INVALID_PARAMETER_VALUE,
                    )
        row.change = record["change"]
        row.hashes = json.dumps(record["hashes"])
        row.metadata_json = json.dumps(metadata)
        row.git_repo = record["git_repo"]
        row.git_tag = record["git_tag"]
        row.git_commit = record["git_commit"]
        row.released_by = record.get("released_by")
        if session.get(SqlDatasetEntry, record["name"]) is None:
            session.add(SqlDatasetEntry(name=record["name"], repo=None, created_at=_now_ms()))
        _register_changelog(session, record["name"], changes)
        session.flush()
        return row.to_dict()


def list_dataset_versions(store: Any, name: Optional[str] = None) -> list[dict]:
    """List released versions, newest first.

    Args:
        store: The tracking server's SQL store.
        name: Restrict to one dataset; ``None`` lists every dataset.

    Returns:
        Version rows ordered by registration time, newest first.
    """
    with _session(store) as session:
        query = sqlalchemy.select(SqlDatasetVersion).order_by(SqlDatasetVersion.created_at.desc())
        if name is not None:
            query = query.where(SqlDatasetVersion.name == name)
        return [row.to_dict() for row in session.execute(query).scalars()]


# ===== Jobs =====


def create_release_job(
    store: Any,
    repo: str,
    name: str,
    version: str,
    change: str,
    dry_run: bool,
    deletions: Optional[list[str]] = None,
) -> dict:
    """Record a new job, refusing a second active one for the same repository.

    Args:
        store: The tracking server's SQL store.
        repo: Repository the job runs in.
        name: Dataset name.
        version: Requested version.
        change: One-line change description.
        dry_run: Whether the job only checks.
        deletions: Units to delete with this release.

    Returns:
        The new job row, status ``pending``.

    Raises:
        MlflowException: If the repository already has a pending or running job.
    """
    with _session(store) as session:
        active = (
            session.execute(
                sqlalchemy.select(SqlDatasetReleaseJob)
                .where(SqlDatasetReleaseJob.repo == repo)
                .where(SqlDatasetReleaseJob.status.in_(JOB_ACTIVE))
            )
            .scalars()
            .first()
        )
        if active is not None:
            raise MlflowException(
                f"job {active.job_id} ({active.name} {active.version}) is still {active.status} "
                f"in {repo}",
                error_code=INVALID_PARAMETER_VALUE,
            )
        now = _now_ms()
        row = SqlDatasetReleaseJob(
            job_id=uuid.uuid4().hex,
            repo=repo,
            name=name,
            version=version,
            change=change,
            deletions=json.dumps(list(deletions or [])),
            dry_run=dry_run,
            status=JOB_PENDING,
            steps="{}",
            findings="[]",
            log="",
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        session.flush()
        return row.to_dict()


def update_release_job(
    store: Any,
    job_id: str,
    status: Optional[str] = None,
    pid: Optional[int] = None,
    step: Optional[tuple[int, str]] = None,
    findings: Optional[list[dict]] = None,
    log_line: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    """Apply a worker's progress report to its job row.

    Args:
        store: The tracking server's SQL store.
        job_id: The job to update.
        status: New job status.
        pid: Worker process id.
        step: ``(step number, step status)`` to merge into ``steps``.
        findings: Check findings, replacing the stored list.
        log_line: Text appended to the log.
        error: Failure message.
    """
    with _session(store) as session:
        row = session.get(SqlDatasetReleaseJob, job_id)
        if row is None:
            return
        if status is not None:
            row.status = status
        if pid is not None:
            row.pid = pid
        if step is not None:
            row.steps = json.dumps({**json.loads(row.steps), str(step[0]): step[1]})
        if findings is not None:
            row.findings = json.dumps(findings)
        if log_line is not None:
            row.log = row.log + log_line + "\n"
        if error is not None:
            row.error = error
        row.updated_at = _now_ms()


def get_release_job(store: Any, job_id: str) -> Optional[dict]:
    """Return one job row, or ``None`` if the id is unknown."""
    with _session(store) as session:
        row = session.get(SqlDatasetReleaseJob, job_id)
        return row.to_dict() if row is not None else None


def list_release_jobs(store: Any, name: Optional[str] = None, limit: int = 20) -> list[dict]:
    """List recent jobs, newest first, without their logs.

    Args:
        store: The tracking server's SQL store.
        name: Restrict to one dataset; ``None`` lists every dataset.
        limit: Maximum number of jobs.

    Returns:
        Job rows with ``log`` blanked to keep the listing small.
    """
    with _session(store) as session:
        query = sqlalchemy.select(SqlDatasetReleaseJob)
        if name is not None:
            query = query.where(SqlDatasetReleaseJob.name == name)
        query = query.order_by(SqlDatasetReleaseJob.created_at.desc()).limit(limit)
        return [{**row.to_dict(), "log": ""} for row in session.execute(query).scalars()]
