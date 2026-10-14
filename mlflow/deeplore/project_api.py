"""Projects: registered owners of experiments and of one run-number sequence.

A project is created directly; it is never parsed from an experiment name. An
experiment belongs to one project through its ``project`` experiment tag,
written when the experiment is created under the project. Every experiment of
a project shares the project's ``run_num`` sequence: the server hands out the
numbers, so two runs starting together never get the same one, and a number is
never handed out twice, even after its run is deleted.

Sections: Tables, Projects, Experiments, Run numbers, Handlers, Routes. The
tables are created on first use and are not part of MLflow's Alembic history.
A newly created project table adopts the projects that already own a
run-number sequence, so their runs keep numbering without an offline step.

Naming table: ``create_*`` / ``delete_*`` write, ``list_*`` returns many
records, ``allocate_*`` reserves a number, ``handle_*`` serves a request and
``register_*`` attaches routes.
"""

from __future__ import annotations

import re
import threading
import time
import urllib.parse
from contextlib import AbstractContextManager, contextmanager
from typing import TYPE_CHECKING, Any, Callable, Iterator, Optional
from weakref import WeakSet

import sqlalchemy
from flask import Flask, Response, jsonify, request
from sqlalchemy import BigInteger, Column, String, Text
from sqlalchemy.orm import declarative_base

from mlflow.entities import ExperimentTag
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import (
    INVALID_PARAMETER_VALUE,
    RESOURCE_ALREADY_EXISTS,
    RESOURCE_DOES_NOT_EXIST,
)
from mlflow.store.tracking.dbmodels.models import SqlExperiment, SqlExperimentTag, SqlRun, SqlTag

if TYPE_CHECKING:
    from sqlalchemy.engine import Engine
    from sqlalchemy.orm import Session

    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

# ===== Tables =====

_Base = declarative_base()
_initialized_engines: WeakSet[Engine] = WeakSet()
_initialization_lock = threading.Lock()

API_PREFIXES: tuple[str, ...] = ("/api/2.0/deeplore", "/ajax-api/2.0/deeplore")
PROJECT_TAG = "project"
# Hyphen-free: published files are named <project>-<run_num>.
PROJECT_PATTERN = re.compile(r"[a-z0-9_]+")
RUN_NUM_PATTERN = re.compile(r"r?([0-9]+)")


class SqlProject(_Base):
    """One registered project.

    Owns the name and description. Experiments link to it through their
    ``project`` tag; its run-number position is a ``SqlRunNumber`` row.
    """

    __tablename__ = "deeplore_projects"

    name = Column(String(256), primary_key=True)
    description = Column(Text)
    created_at = Column(BigInteger, nullable=False)

    def to_dict(self) -> dict[str, Any]:
        """Return the row as a JSON-ready dict."""
        return {"name": self.name, "description": self.description, "created_at": self.created_at}


class SqlRunNumber(_Base):
    """The highest run number ever allocated in one project.

    Owns the sequence position only; the runs carry their number as a tag. The
    row outlives its project, so a project created again never reuses a number.
    """

    __tablename__ = "deeplore_run_numbers"

    project = Column(String(256), primary_key=True)
    last_number = Column(BigInteger, nullable=False)


def _now_ms() -> int:
    return int(time.time() * 1000)


@contextmanager
def _locked_session(store: SqlAlchemyStore) -> Iterator[Session]:
    with store.ManagedSessionMaker() as session:
        if store.engine.dialect.name == "sqlite":
            # SQLite ignores row locks; take the write lock before reading.
            session.execute(sqlalchemy.text("BEGIN IMMEDIATE"))
        yield session


def _adopt_run_number_projects(session: Session) -> None:
    """Register every project that owned a run-number sequence before projects were tables."""
    names = session.execute(sqlalchemy.select(SqlRunNumber.project)).scalars().all()
    for name in names:
        if PROJECT_PATTERN.fullmatch(name) and session.get(SqlProject, name) is None:
            session.add(SqlProject(name=name, description=None, created_at=_now_ms()))


def _session(store: SqlAlchemyStore) -> AbstractContextManager[Session]:
    """Create the tables once per engine, then open a session holding the write lock."""
    adopting = False
    with _initialization_lock:
        if store.engine not in _initialized_engines:
            adopting = not sqlalchemy.inspect(store.engine).has_table(SqlProject.__tablename__)
            _Base.metadata.create_all(store.engine, checkfirst=True)
            _initialized_engines.add(store.engine)
    if adopting:
        # Committed on its own, so a failing first request cannot roll the adoption back.
        with _locked_session(store) as session:
            _adopt_run_number_projects(session)
    return _locked_session(store)


# ===== Projects =====


def _validate_project_name(name: str) -> None:
    if not isinstance(name, str) or PROJECT_PATTERN.fullmatch(name) is None:
        raise MlflowException(
            "project must be a nonempty name of lowercase letters, digits and underscores",
            error_code=INVALID_PARAMETER_VALUE,
        )


def _require_project(session: Session, name: str) -> SqlProject:
    row = session.get(SqlProject, name)
    if row is None:
        raise MlflowException(f"unknown project {name!r}", error_code=RESOURCE_DOES_NOT_EXIST)
    return row


def _find_project_experiments(session: Session, name: str) -> list[str]:
    """Return the names of the project's experiments, deleted ones included."""
    return list(
        session.execute(
            sqlalchemy.select(SqlExperiment.name)
            .join(SqlExperimentTag, SqlExperimentTag.experiment_id == SqlExperiment.experiment_id)
            .where(SqlExperimentTag.key == PROJECT_TAG, SqlExperimentTag.value == name)
            .order_by(SqlExperiment.name)
        ).scalars()
    )


def list_projects(store: SqlAlchemyStore) -> list[dict[str, Any]]:
    """Return every registered project, ordered by name."""
    with _session(store) as session:
        rows = session.execute(sqlalchemy.select(SqlProject).order_by(SqlProject.name)).scalars()
        return [row.to_dict() for row in rows]


def create_project(store: SqlAlchemyStore, name: str, description: Optional[str]) -> dict[str, Any]:
    """Register a project.

    Args:
        store: The tracking server's SQL store.
        name: Lowercase letters, digits and underscores; it names published files.
        description: Optional free text.

    Returns:
        The new project row.

    Raises:
        MlflowException: If the name is invalid or already registered.
    """
    _validate_project_name(name)
    with _session(store) as session:
        if session.get(SqlProject, name) is not None:
            raise MlflowException(
                f"project {name!r} already exists", error_code=RESOURCE_ALREADY_EXISTS
            )
        row = SqlProject(name=name, description=description or None, created_at=_now_ms())
        session.add(row)
        session.flush()
        return row.to_dict()


def delete_project(store: SqlAlchemyStore, name: str) -> None:
    """Remove a project that owns no experiment, deleted experiments included.

    Its run-number position is kept, so the name never reuses a number.

    Raises:
        MlflowException: If the project is unknown or still owns experiments.
    """
    with _session(store) as session:
        row = _require_project(session, name)
        experiments = _find_project_experiments(session, name)
        if experiments:
            raise MlflowException(
                f"project {name!r} still owns experiments, deleted ones included: "
                + ", ".join(experiments),
                error_code=INVALID_PARAMETER_VALUE,
            )
        session.delete(row)


# ===== Experiments =====


def _validate_artifact_location(artifact_location: str) -> None:
    """Apply the native create-experiment check on artifact locations."""
    from mlflow.utils.uri import validate_query_string

    parsed = urllib.parse.urlparse(artifact_location)
    if parsed.fragment or parsed.params:
        raise MlflowException(
            "'artifact_location' URL can't include fragments or params.",
            error_code=INVALID_PARAMETER_VALUE,
        )
    validate_query_string(parsed.query)


def create_project_experiment(
    store: SqlAlchemyStore, project: str, name: str, artifact_location: Optional[str]
) -> str:
    """Create an experiment owned by a registered project.

    Args:
        store: The tracking server's SQL store.
        project: Registered project that owns the experiment.
        name: Experiment name, unique across all projects.
        artifact_location: Artifact root; None or empty uses the server default.

    Returns:
        The new experiment's identifier.

    Raises:
        MlflowException: If the project is unknown or the name is taken.
    """
    with _session(store) as session:
        _require_project(session, project)
    if artifact_location:
        _validate_artifact_location(artifact_location)
    return store.create_experiment(
        name, artifact_location or None, [ExperimentTag(PROJECT_TAG, project)]
    )


# ===== Run numbers =====


def _find_tagged_maximum(session: Session, project: str) -> int:
    """Return the highest number any run of the project carries, deleted runs included."""
    values = session.execute(
        sqlalchemy.select(SqlTag.value)
        .join(SqlRun, SqlRun.run_uuid == SqlTag.run_uuid)
        .join(SqlExperimentTag, SqlExperimentTag.experiment_id == SqlRun.experiment_id)
        .where(
            SqlExperimentTag.key == PROJECT_TAG,
            SqlExperimentTag.value == project,
            SqlTag.key.in_(("run_num", "run_seq")),
        )
    ).scalars()
    numbers = [0]
    for value in values:
        match = RUN_NUM_PATTERN.fullmatch(value or "")
        if match:
            numbers.append(int(match.group(1)))
    return max(numbers)


def allocate_run_number(store: SqlAlchemyStore, project: str) -> int:
    """Reserve the next run number of a registered project.

    The number follows both the last one allocated here and the highest one
    any run of the project's experiments already carries, so runs tagged
    before the sequence existed are never collided with.

    Args:
        store: The tracking server's SQL store.
        project: Registered project name.

    Returns:
        The reserved number, 1 for a project's first run.

    Raises:
        MlflowException: If the project is unknown.
    """
    with _session(store) as session:
        _require_project(session, project)
        row = session.get(SqlRunNumber, project, with_for_update=True)
        if row is None:
            row = SqlRunNumber(project=project, last_number=0)
            session.add(row)
        row.last_number = max(row.last_number, _find_tagged_maximum(session, project)) + 1
        session.flush()
        return row.last_number


# ===== Handlers =====


def _get_body() -> dict[str, Any]:
    body = request.get_json(force=True, silent=True)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise MlflowException("request body must be a JSON object", INVALID_PARAMETER_VALUE)
    return body


def _get_optional_string(body: dict[str, Any], key: str) -> Optional[str]:
    value = body.get(key)
    if value is not None and not isinstance(value, str):
        raise MlflowException(f"{key} must be a string", INVALID_PARAMETER_VALUE)
    return value.strip() if value else None


def handle_list_projects() -> Response:
    """Return every registered project."""
    from mlflow.deeplore.evaluation_api import _get_store

    return jsonify({"projects": list_projects(_get_store())})


def handle_create_project() -> Response:
    """Register a project from ``{"name", "description"}``."""
    from mlflow.deeplore.evaluation_api import _get_store

    body = _get_body()
    project = create_project(
        _get_store(), body.get("name"), _get_optional_string(body, "description")
    )
    return jsonify({"project": project})


def handle_delete_project(project: str) -> Response:
    """Remove a project that owns no experiment."""
    from mlflow.deeplore.evaluation_api import _get_store

    delete_project(_get_store(), project)
    return jsonify({"deleted": project})


def handle_create_project_experiment(project: str) -> Response:
    """Create an experiment from ``{"name", "artifact_location"}`` under the project."""
    from mlflow.deeplore.evaluation_api import _get_store

    body = _get_body()
    name = _get_optional_string(body, "name")
    if not name:
        raise MlflowException("experiment name is required", INVALID_PARAMETER_VALUE)
    experiment_id = create_project_experiment(
        _get_store(), project, name, _get_optional_string(body, "artifact_location")
    )
    return jsonify({"experiment_id": experiment_id})


def handle_allocate_run_number(project: str) -> Response:
    """Reserve and return the project's next ``run_num``, e.g. ``r12``."""
    from mlflow.deeplore.evaluation_api import _get_store

    number = allocate_run_number(_get_store(), project)
    return jsonify({"run_num": f"r{number}", "number": number})


# ===== Routes =====

ROUTES: tuple[tuple[str, Callable[..., Response], str], ...] = (
    ("/projects", handle_list_projects, "GET"),
    ("/projects", handle_create_project, "POST"),
    ("/projects/<project>", handle_delete_project, "DELETE"),
    ("/projects/<project>/experiments", handle_create_project_experiment, "POST"),
    ("/projects/<project>/run-nums", handle_allocate_run_number, "POST"),
)


def register_project_routes(app: Flask) -> None:
    """Attach project routes under both tracking server API prefixes.

    Args:
        app: The MLflow tracking server application.
    """
    from mlflow.server.handlers import _add_static_prefix, catch_mlflow_exception

    for path, handler, method in ROUTES:
        view = catch_mlflow_exception(handler)
        for prefix in API_PREFIXES:
            app.add_url_rule(
                _add_static_prefix(prefix + path),
                handler.__name__,
                view,
                methods=[method],
            )
