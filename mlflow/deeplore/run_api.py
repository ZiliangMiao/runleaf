"""Project-wide run numbers allocated by the tracking server.

A project is the first hyphen-separated field of an experiment name; every
experiment of a project shares one ``run_num`` sequence. The server hands out
the numbers so two runs starting together never get the same one, and a number
is never handed out twice, even after its run is deleted.

Sections: Tables, Allocation, Handler, Routes. The table is created on first
use and is not part of MLflow's Alembic history.

Naming table: ``allocate_*`` reserves a number, ``handle_*`` serves a request,
and ``register_*`` attaches routes.
"""

from __future__ import annotations

import re
import threading
from typing import TYPE_CHECKING, Callable
from weakref import WeakSet

import sqlalchemy
from flask import Flask, Response, jsonify
from sqlalchemy import BigInteger, Column, String
from sqlalchemy.orm import declarative_base

from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE
from mlflow.store.tracking.dbmodels.models import SqlExperiment, SqlRun, SqlTag

if TYPE_CHECKING:
    from contextlib import AbstractContextManager

    from sqlalchemy.engine import Engine
    from sqlalchemy.orm import Session

    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

# ===== Tables =====

_Base = declarative_base()
_initialized_engines: WeakSet[Engine] = WeakSet()
_initialization_lock = threading.Lock()

API_PREFIXES: tuple[str, ...] = ("/api/2.0/deeplore", "/ajax-api/2.0/deeplore")
PROJECT_PATTERN = re.compile(r"[^\s-]+")
RUN_NUM_PATTERN = re.compile(r"r?([0-9]+)")


class SqlRunNumber(_Base):
    """The highest run number ever allocated in one project.

    Owns the sequence position only; the runs carry their number as a tag.
    """

    __tablename__ = "deeplore_run_numbers"

    project = Column(String(256), primary_key=True)
    last_number = Column(BigInteger, nullable=False)


def _session(store: SqlAlchemyStore) -> AbstractContextManager[Session]:
    with _initialization_lock:
        if store.engine not in _initialized_engines:
            _Base.metadata.create_all(store.engine, checkfirst=True)
            _initialized_engines.add(store.engine)
    return store.ManagedSessionMaker()


# ===== Allocation =====


def _find_tagged_maximum(session: Session, project: str) -> int:
    """Return the highest number any run of the project carries, deleted runs included."""
    rows = session.execute(
        sqlalchemy.select(SqlExperiment.name, SqlTag.value)
        .join(SqlRun, SqlRun.experiment_id == SqlExperiment.experiment_id)
        .join(SqlTag, SqlTag.run_uuid == SqlRun.run_uuid)
        .where(SqlTag.key.in_(("run_num", "run_seq")))
    )
    numbers = [0]
    for experiment_name, value in rows:
        prefix, separator, suffix = experiment_name.partition("-")
        match = RUN_NUM_PATTERN.fullmatch(value or "")
        if prefix == project and separator and suffix.strip() and match:
            numbers.append(int(match.group(1)))
    return max(numbers)


def allocate_run_number(store: SqlAlchemyStore, project: str) -> int:
    """Reserve the next run number of a project.

    The number follows both the last one allocated here and the highest one
    any run already carries, so runs tagged before this table existed are
    never collided with.

    Args:
        store: The tracking server's SQL store.
        project: First hyphen-separated field of the project's experiment names.

    Returns:
        The reserved number, 1 for a project's first run.

    Raises:
        MlflowException: If the project name is empty or holds whitespace or hyphens.
    """
    if PROJECT_PATTERN.fullmatch(project) is None:
        raise MlflowException(
            "project must be a nonempty name without whitespace or hyphens",
            error_code=INVALID_PARAMETER_VALUE,
        )
    with _session(store) as session:
        if store.engine.dialect.name == "sqlite":
            # SQLite ignores row locks; take the write lock before reading.
            session.execute(sqlalchemy.text("BEGIN IMMEDIATE"))
        row = session.get(SqlRunNumber, project, with_for_update=True)
        if row is None:
            row = SqlRunNumber(project=project, last_number=0)
            session.add(row)
        row.last_number = max(row.last_number, _find_tagged_maximum(session, project)) + 1
        session.flush()
        return row.last_number


# ===== Handler =====


def handle_allocate_run_number(project: str) -> Response:
    """Reserve and return the project's next ``run_num``, e.g. ``r12``."""
    from mlflow.deeplore.evaluation_api import _get_store

    number = allocate_run_number(_get_store(), project)
    return jsonify({"run_num": f"r{number}", "number": number})


# ===== Routes =====

ROUTES: tuple[tuple[str, Callable[..., Response], str], ...] = (
    ("/projects/<project>/run-nums", handle_allocate_run_number, "POST"),
)


def register_run_routes(app: Flask) -> None:
    """Attach run number routes under both tracking server API prefixes.

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
