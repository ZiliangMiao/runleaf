"""REST endpoints and the background worker for dataset releases.

Endpoints, served under both ``/api/2.0/deeplore`` and ``/ajax-api/2.0/deeplore``:

    GET  /datasets                      datasets of the configured repositories + registry state
    GET  /datasets/<name>/versions      released versions of one dataset
    POST /datasets/versions             register a released version (used by the CLI)
    POST /datasets/<name>/releases      start a check (``dry_run``) or a release; returns its job
    GET  /dataset-releases              recent jobs
    GET  /dataset-releases/<job_id>     one job with its log

A release hashes and pushes gigabytes, far beyond a request timeout, and the
server runs several worker processes. ``POST .../releases`` therefore only
records a job and spawns a detached process (``python -m
mlflow.deeplore.dataset_api <job_id>``) that reports its progress into the job
row, where any server worker can read it.

Server environment:

    DEEPLORE_DATASET_REPOS            dataset repository roots, ``os.pathsep`` separated
    DEEPLORE_DATASET_SKIP_GIT_HOOKS   ``true`` to commit with ``--no-verify`` when the
                                      server cannot run a repository's git hooks

The release process needs ``git`` and ``dvc`` on ``PATH`` and credentials for
both remotes. Like the rest of MLflow these endpoints are unauthenticated.

Sections:
- Config: repositories and dataset lookup.
- Worker: the detached release process.
- Handlers: one function per endpoint.
- Routes: registration on the Flask app.

Verb paradigm: ``find_*`` resolves configuration, ``build_*`` shapes a response,
``run_*`` executes a job, ``handle_*`` answers one endpoint.
"""

import os
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request

from mlflow.deeplore import dataset_registry as registry
from mlflow.deeplore.dataset_release import (
    LEVEL_ERROR,
    Dataset,
    ReleaseError,
    build_next_versions,
    find_datasets,
    parse_changelog,
    parse_version,
    read_metadata,
    release_dataset,
)
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import (
    FEATURE_DISABLED,
    INVALID_PARAMETER_VALUE,
    RESOURCE_DOES_NOT_EXIST,
)

# ===== Config: repositories and dataset lookup =====

REPOS_ENV_VAR = "DEEPLORE_DATASET_REPOS"
SKIP_HOOKS_ENV_VAR = "DEEPLORE_DATASET_SKIP_GIT_HOOKS"
API_PREFIXES: tuple[str, ...] = ("/api/2.0/deeplore", "/ajax-api/2.0/deeplore")
# A worker flushes its log every interval; a job silent for longer than the
# stale limit lost its worker.
REPORT_INTERVAL_S = 2.0
STALE_AFTER_MS = 120_000


def _get_store() -> Any:
    """Return the tracking server's SQL store.

    Raises:
        MlflowException: If the server runs on a non-SQL backend store.
    """
    from mlflow.server.handlers import _get_tracking_store

    store = _get_tracking_store()
    if not hasattr(store, "ManagedSessionMaker"):
        raise MlflowException(
            "dataset releases need a SQL backend store", error_code=FEATURE_DISABLED
        )
    return store


def find_repos() -> list[Path]:
    """List the dataset repositories configured through ``DEEPLORE_DATASET_REPOS``."""
    return [Path(part) for part in os.environ.get(REPOS_ENV_VAR, "").split(os.pathsep) if part]


def find_dataset(name: str) -> Dataset:
    """Resolve a dataset name to its repository.

    Args:
        name: Dataset name.

    Returns:
        The dataset in the first configured repository that holds it.

    Raises:
        MlflowException: If no configured repository holds the dataset.
    """
    for repo in find_repos():
        for dataset in find_datasets(repo):
            if dataset.name == name:
                return dataset
    raise MlflowException(
        f"dataset {name!r} is not in any repository of ${REPOS_ENV_VAR}",
        error_code=RESOURCE_DOES_NOT_EXIST,
    )


# ===== Worker: the detached release process =====


def _spawn_worker(job_id: str) -> int:
    """Start the detached worker of one job and return its process id."""
    process = subprocess.Popen(
        [sys.executable, "-m", "mlflow.deeplore.dataset_api", job_id],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    # Reap the child when it exits so it does not linger as a zombie.
    threading.Thread(target=process.wait, daemon=True).start()
    return process.pid


def _expire_stale_job(store: Any, job: dict) -> dict:
    """Mark an active job as failed once its worker stopped reporting."""
    silent_ms = int(time.time() * 1000) - job["updated_at"]
    if job["status"] not in registry.JOB_ACTIVE or silent_ms < STALE_AFTER_MS:
        return job
    registry.update_release_job(
        store,
        job["job_id"],
        status=registry.JOB_FAILED,
        error=f"the release worker stopped reporting {silent_ms // 1000}s ago; "
        "inspect the repository before releasing again",
    )
    return registry.get_release_job(store, job["job_id"])


def run_release_job(job_id: str) -> None:
    """Run one recorded job to completion, reporting progress into its row.

    Args:
        job_id: Id of a job created by ``POST /datasets/<name>/releases``.
    """
    store = _get_store()
    job = registry.get_release_job(store, job_id)
    if job is None:
        sys.exit(f"unknown dataset release job {job_id}")

    pending_lines: list[str] = []
    lines_lock = threading.Lock()
    finished = threading.Event()

    def flush_log() -> None:
        with lines_lock:
            text = "\n".join(pending_lines)
            pending_lines.clear()
        # An empty report still refreshes updated_at: it is the heartbeat.
        registry.update_release_job(store, job_id, log_line=text or None)

    def report_until_finished() -> None:
        while not finished.wait(REPORT_INTERVAL_S):
            flush_log()

    def log(line: str) -> None:
        with lines_lock:
            pending_lines.append(line)

    registry.update_release_job(store, job_id, status=registry.JOB_RUNNING, pid=os.getpid())
    reporter = threading.Thread(target=report_until_finished, daemon=True)
    reporter.start()
    status, error, findings = registry.JOB_SUCCEEDED, None, []
    try:
        result = release_dataset(
            repo=Path(job["repo"]),
            name=job["name"],
            version=job["version"],
            change=job["change"],
            register=lambda record: registry.register_dataset_version(store, record),
            registered_versions=[
                row["version"] for row in registry.list_dataset_versions(store, job["name"])
            ],
            dry_run=job["dry_run"],
            skip_hooks=os.environ.get(SKIP_HOOKS_ENV_VAR, "").lower() == "true",
            on_step=lambda step, step_status: registry.update_release_job(
                store, job_id, step=(step, step_status)
            ),
            log=log,
        )
        findings = result["findings"]
        n_errors = sum(1 for finding in findings if finding["level"] == LEVEL_ERROR)
        if n_errors:
            status, error = registry.JOB_FAILED, f"{n_errors} check(s) failed"
    except ReleaseError as release_error:
        status, error = registry.JOB_FAILED, str(release_error)
        findings = [vars(finding) for finding in release_error.findings]
    except Exception:
        status, error = registry.JOB_FAILED, traceback.format_exc()
    finally:
        finished.set()
        reporter.join()
        flush_log()
        registry.update_release_job(store, job_id, status=status, error=error, findings=findings)


# ===== Handlers: one function per endpoint =====


def build_dataset_summary(dataset: Dataset, versions: list[dict]) -> dict:
    """Describe one repository dataset for the listing.

    Args:
        dataset: The dataset in its repository.
        versions: Its released versions, newest first.

    Returns:
        Working-tree metadata, which units exist, the versions that may be
        released next and the latest registered version.
    """
    summary: dict = {
        "name": dataset.name,
        "repo": str(dataset.repo),
        "units": {unit_dir.name: unit_dir.is_dir() for unit_dir in dataset.unit_dirs},
        "metadata": None,
        "next_versions": [],
        "error": None,
        "latest_release": versions[0] if versions else None,
        "release_count": len(versions),
    }
    try:
        summary["metadata"] = read_metadata(dataset.metadata_path)
        current = summary["metadata"].get("version")
        summary["next_versions"] = build_next_versions(str(current) if current else None)
    except (ReleaseError, ValueError) as error:
        summary["error"] = str(error)
    return summary


def handle_list_datasets() -> Response:
    """List every dataset of the configured repositories with its registry state."""
    store = _get_store()
    versions_by_name: dict[str, list[dict]] = {}
    for row in registry.list_dataset_versions(store):
        versions_by_name.setdefault(row["name"], []).append(row)
    changelogs = registry.list_dataset_changelogs(store)

    repos = find_repos()
    datasets = [
        build_dataset_summary(dataset, versions_by_name.get(dataset.name, []))
        for repo in repos
        for dataset in find_datasets(repo)
    ]
    # Persisted history remains visible when its repository is unavailable.
    listed = {summary["name"] for summary in datasets}
    for name in sorted(versions_by_name.keys() | changelogs.keys()):
        if name not in listed:
            versions = versions_by_name.get(name, [])
            datasets.append(
                {
                    "name": name,
                    "repo": None,
                    "units": {},
                    "metadata": None,
                    "next_versions": [],
                    "error": "not found in any configured repository",
                    "latest_release": versions[0] if versions else None,
                    "release_count": len(versions),
                }
            )
    for dataset in datasets:
        persisted = changelogs.get(dataset["name"], [])
        try:
            changes = parse_changelog((dataset["metadata"] or {}).get("changelog"))
            changes.update(parse_changelog(persisted))
            dataset["changelog"] = [
                {version: change}
                for version, change in sorted(changes.items(), key=lambda item: parse_version(item[0]))
            ]
        except ValueError as error:
            dataset["changelog"] = persisted
            dataset["error"] = f"invalid changelog: {error}"
    return jsonify({"repos": [str(repo) for repo in repos], "datasets": datasets})


def handle_list_dataset_versions(name: str) -> Response:
    """List the released versions of one dataset, newest first."""
    return jsonify({"versions": registry.list_dataset_versions(_get_store(), name)})


def handle_register_dataset_version() -> Response:
    """Register a version released outside the server, e.g. by the CLI."""
    record = request.get_json(force=True, silent=True) or {}
    return jsonify({"version": registry.register_dataset_version(_get_store(), record)})


def handle_start_dataset_release(name: str) -> Response:
    """Start a check or a release of one dataset and return its job."""
    body = request.get_json(force=True, silent=True) or {}
    version = str(body.get("version") or "").strip()
    change = str(body.get("change") or "").strip()
    if not version or not change:
        raise MlflowException("version and change are required", error_code=INVALID_PARAMETER_VALUE)

    store = _get_store()
    dataset = find_dataset(name)
    for job in registry.list_release_jobs(store, limit=50):
        _expire_stale_job(store, job)
    job = registry.create_release_job(
        store, str(dataset.repo), name, version, change, bool(body.get("dry_run"))
    )
    try:
        registry.update_release_job(store, job["job_id"], pid=_spawn_worker(job["job_id"]))
    except OSError as error:
        # Without a worker the job would block the repository until it went stale.
        registry.update_release_job(
            store,
            job["job_id"],
            status=registry.JOB_FAILED,
            error=f"could not start the release worker: {error}",
        )
    return jsonify({"job": registry.get_release_job(store, job["job_id"])})


def handle_list_dataset_releases() -> Response:
    """List recent jobs, optionally of one dataset (``?name=``)."""
    store = _get_store()
    jobs = registry.list_release_jobs(store, name=request.args.get("name"))
    return jsonify({"jobs": [{**_expire_stale_job(store, job), "log": ""} for job in jobs]})


def handle_get_dataset_release(job_id: str) -> Response:
    """Return one job with its findings and log."""
    store = _get_store()
    job = registry.get_release_job(store, job_id)
    if job is None:
        raise MlflowException(
            f"unknown dataset release job {job_id}", error_code=RESOURCE_DOES_NOT_EXIST
        )
    return jsonify({"job": _expire_stale_job(store, job)})


# ===== Routes: registration on the Flask app =====

ROUTES: tuple[tuple[str, Any, str], ...] = (
    ("/datasets", handle_list_datasets, "GET"),
    ("/datasets/versions", handle_register_dataset_version, "POST"),
    ("/datasets/<name>/versions", handle_list_dataset_versions, "GET"),
    ("/datasets/<name>/releases", handle_start_dataset_release, "POST"),
    ("/dataset-releases", handle_list_dataset_releases, "GET"),
    ("/dataset-releases/<job_id>", handle_get_dataset_release, "GET"),
)


def register_dataset_routes(app: Flask) -> None:
    """Attach the dataset endpoints to the tracking server's Flask app.

    Args:
        app: The MLflow server application.
    """
    from mlflow.server.handlers import _add_static_prefix, catch_mlflow_exception

    for path, handler, method in ROUTES:
        view = catch_mlflow_exception(handler)
        for prefix in API_PREFIXES:
            app.add_url_rule(
                _add_static_prefix(prefix + path), handler.__name__, view, methods=[method]
            )


if __name__ == "__main__":
    run_release_job(sys.argv[1])
