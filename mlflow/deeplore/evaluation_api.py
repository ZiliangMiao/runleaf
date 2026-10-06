"""Run evaluation endpoints for the Deeplore tracking server.

Sections: Store, Validation, Handlers, Routes. Normal writes require complete
identity and provenance. Historical imports retain original rows and explain
missing values, while using the same dataset identity validation.

Naming table: ``validate_*`` checks provenance, ``handle_*`` serves requests,
and ``register_*`` attaches routes.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from flask import Flask, Response, jsonify, request

from mlflow.deeplore import evaluation_registry as registry
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import (
    FEATURE_DISABLED,
    INVALID_PARAMETER_VALUE,
    RESOURCE_DOES_NOT_EXIST,
)

if TYPE_CHECKING:
    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

# ===== Store =====

API_PREFIXES: tuple[str, ...] = ("/api/2.0/deeplore", "/ajax-api/2.0/deeplore")


def _get_store() -> SqlAlchemyStore:
    from mlflow.server.handlers import _get_tracking_store

    store = _get_tracking_store()
    if not hasattr(store, "ManagedSessionMaker"):
        raise MlflowException(
            "evaluations need a SQL backend store", error_code=FEATURE_DISABLED
        )
    return store


# ===== Validation =====


def _get_record() -> dict[str, Any]:
    record = request.get_json(force=True, silent=True)
    if not isinstance(record, dict):
        raise MlflowException(
            "evaluation must be a JSON object", INVALID_PARAMETER_VALUE
        )
    return record


def _validate_checkpoint(
    run_id: str, record: dict[str, Any], *, require_best: bool = False
) -> None:
    from mlflow.protos.service_pb2 import ListArtifacts
    from mlflow.server.handlers import list_artifacts_impl

    checkpoint = record.get("ckpt_path")
    if checkpoint is None:
        return
    if not isinstance(checkpoint, str):
        raise MlflowException(
            "ckpt_path must be a string", error_code=INVALID_PARAMETER_VALUE
        )
    registry._validate_artifact_path(checkpoint, "ckpt_path")
    if require_best and Path(checkpoint).name not in ("best_ckpt.pth", "best.pt"):
        raise MlflowException(
            "ckpt_path must identify this run's best_ckpt.pth or best.pt checkpoint",
            error_code=INVALID_PARAMETER_VALUE,
        )
    parent = Path(checkpoint).parent
    message = ListArtifacts(run_id=run_id)
    if parent != Path("."):
        message.path = parent.as_posix()
    files = list_artifacts_impl(message).files
    if not any(file.path == checkpoint and not file.is_dir for file in files):
        raise MlflowException(
            f"checkpoint artifact {checkpoint!r} does not exist in run {run_id}",
            error_code=INVALID_PARAMETER_VALUE,
        )


# ===== Handlers =====


def handle_list_evaluations(run_id: str) -> Response:
    """Return all evaluations stored for the requested run."""
    return jsonify({"evaluations": registry.list_evaluations(_get_store(), run_id)})


def handle_create_evaluation(run_id: str) -> Response:
    """Create a complete evaluation after checking its run artifact ownership."""
    record = _get_record()
    store = _get_store()
    store.get_run(run_id)
    registry._validate_record(record, allow_incomplete=False)
    _validate_checkpoint(run_id, record, require_best=True)
    evaluation, created = registry.create_evaluation(store, run_id, record)
    return jsonify({"evaluation": evaluation, "created": created})


def handle_import_evaluation(run_id: str) -> Response:
    """Import a historical row with explicit missing provenance and deduplication."""
    record = _get_record()
    store = _get_store()
    store.get_run(run_id)
    registry._validate_record(record, allow_incomplete=True)
    _validate_checkpoint(run_id, record)
    evaluation, created = registry.create_evaluation(
        store, run_id, record, allow_incomplete=True
    )
    return jsonify({"evaluation": evaluation, "created": created})


def handle_get_evaluation(evaluation_id: str) -> Response:
    """Return an evaluation by identifier, or a missing-resource response."""
    evaluation = registry.get_evaluation(_get_store(), evaluation_id)
    if evaluation is None:
        raise MlflowException(
            f"unknown evaluation {evaluation_id}", error_code=RESOURCE_DOES_NOT_EXIST
        )
    return jsonify({"evaluation": evaluation})


# ===== Routes =====

ROUTES: tuple[tuple[str, Callable[..., Response], str], ...] = (
    ("/runs/<run_id>/evaluations", handle_list_evaluations, "GET"),
    ("/runs/<run_id>/evaluations", handle_create_evaluation, "POST"),
    ("/runs/<run_id>/evaluations/import", handle_import_evaluation, "POST"),
    ("/evaluations/<evaluation_id>", handle_get_evaluation, "GET"),
)


def register_evaluation_routes(app: Flask) -> None:
    """Attach evaluation routes under both tracking server API prefixes.

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
