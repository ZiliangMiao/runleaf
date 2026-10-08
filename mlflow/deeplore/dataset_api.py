"""REST endpoints and the background worker for dataset releases.

Endpoints, served under both ``/api/2.0/deeplore`` and ``/ajax-api/2.0/deeplore``:

    GET    /datasets                      datasets of the configured repositories + registry state
    POST   /datasets                      create a dataset: registration + metadata.yaml template
    DELETE /datasets/<name>               delete a dataset that was never released
    GET    /datasets/<name>/versions      registered versions of one dataset + archived flag
    POST   /datasets/versions             register a released version (used by the CLI)
    POST   /datasets/<name>/releases      start a check (``dry_run``) or a release; returns its job
    POST   /datasets/<name>/archive       archive a released dataset
    POST   /datasets/<name>/unarchive     undo an archive
    GET    /dataset-releases              recent jobs
    GET    /dataset-releases/<job_id>     one job with its log

Archiving and unarchiving only move pointer files and one commit, so they run
inside the request. A release hashes and pushes gigabytes, far beyond a request timeout, and the
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
import shutil
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Optional

from flask import Flask, Response, jsonify, request

from mlflow.deeplore import dataset_registry as registry
from mlflow.deeplore.dataset_release import (
    LEVEL_ERROR,
    NAME_PATTERN,
    UNITS,
    Dataset,
    ReleaseError,
    build_metadata_template,
    build_next_versions,
    find_datasets,
    parse_changelog,
    parse_version,
    read_metadata,
    release_archive,
    release_dataset,
    release_unarchive,
    write_metadata,
)
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import (
    FEATURE_DISABLED,
    INVALID_PARAMETER_VALUE,
    RESOURCE_ALREADY_EXISTS,
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
STATUS_UNRELEASED = "unreleased"
STATUS_RELEASED = "released"
STATUS_ARCHIVED = "archived"


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


def find_repo(path: str) -> Path:
    """Resolve a requested repository to one of the configured roots.

    Args:
        path: Repository root as the client names it.

    Returns:
        The matching configured root, resolved.

    Raises:
        MlflowException: If the path is not a configured repository.
    """
    for repo in find_repos():
        if path and repo.resolve() == Path(path).resolve():
            return repo.resolve()
    raise MlflowException(
        f"{path!r} is not a repository of ${REPOS_ENV_VAR}", error_code=INVALID_PARAMETER_VALUE
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
        entry = registry.get_dataset(store, job["name"])
        result = release_dataset(
            repo=Path(job["repo"]),
            name=job["name"],
            version=job["version"],
            change=job["change"],
            register=lambda record: registry.register_dataset_version(store, record),
            registered_versions=[
                row["version"] for row in registry.list_dataset_versions(store, job["name"])
            ],
            deletions=job["deletions"],
            archived=bool(entry and entry["archived"]),
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


def build_dataset_status(versions: list[dict], entry: Optional[dict]) -> str:
    """Return ``archived``, ``released`` or ``unreleased`` for one dataset."""
    if entry and entry["archived"]:
        return STATUS_ARCHIVED
    return STATUS_RELEASED if versions else STATUS_UNRELEASED


def build_dataset_summary(
    dataset: Dataset, versions: list[dict], entry: Optional[dict] = None
) -> dict:
    """Describe one repository dataset for the listing.

    Args:
        dataset: The dataset in its repository.
        versions: Its registered versions, newest first.
        entry: Its registry row, if it has one.

    Returns:
        Working-tree metadata, which units exist, its status, the versions
        that may be released next and the latest registered version. A
        working-tree version MLflow does not hold is an unfinished release:
        it is reported and no next version is offered until it is retried.
    """
    summary: dict = {
        "name": dataset.name,
        "repo": str(dataset.repo),
        "status": build_dataset_status(versions, entry),
        "units": {unit_dir.name: unit_dir.is_dir() for unit_dir in dataset.unit_dirs},
        "metadata": None,
        "next_versions": [],
        "unfinished_version": None,
        "error": None,
        "latest_release": versions[0] if versions else None,
        "release_count": len(versions),
    }
    try:
        summary["metadata"] = read_metadata(dataset.metadata_path)
        current = summary["metadata"].get("version")
        if current and str(current) not in {row["version"] for row in versions}:
            summary["unfinished_version"] = str(current)
        else:
            summary["next_versions"] = build_next_versions(str(current) if current else None)
    except (ReleaseError, ValueError) as error:
        summary["error"] = str(error)
    return summary


def handle_list_datasets() -> Response:
    """List the datasets of the configured repositories with their registry state.

    Archived datasets are listed only with ``?include_archived=true``.
    """
    store = _get_store()
    versions_by_name: dict[str, list[dict]] = {}
    for row in registry.list_dataset_versions(store):
        versions_by_name.setdefault(row["name"], []).append(row)
    changelogs = registry.list_dataset_changelogs(store)
    entries = registry.list_datasets(store)

    repos = find_repos()
    datasets = [
        build_dataset_summary(
            dataset, versions_by_name.get(dataset.name, []), entries.get(dataset.name)
        )
        for repo in repos
        for dataset in find_datasets(repo)
    ]
    # Persisted history remains visible when its directory is unavailable.
    listed = {summary["name"] for summary in datasets}
    for name in sorted(versions_by_name.keys() | changelogs.keys() | entries.keys()):
        if name not in listed:
            versions = versions_by_name.get(name, [])
            status = build_dataset_status(versions, entries.get(name))
            datasets.append(
                {
                    "name": name,
                    "repo": (entries.get(name) or {}).get("repo"),
                    "status": status,
                    "units": {},
                    "metadata": None,
                    "next_versions": [],
                    "unfinished_version": None,
                    # An archived dataset has no directory by design.
                    "error": None
                    if status == STATUS_ARCHIVED
                    else "not found in any configured repository",
                    "latest_release": versions[0] if versions else None,
                    "release_count": len(versions),
                }
            )
    if request.args.get("include_archived", "").lower() != "true":
        datasets = [summary for summary in datasets if summary["status"] != STATUS_ARCHIVED]
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
    """List one dataset's registered versions, newest first, and whether it is archived."""
    store = _get_store()
    entry = registry.get_dataset(store, name)
    return jsonify(
        {
            "versions": registry.list_dataset_versions(store, name),
            "archived": bool(entry and entry["archived"]),
        }
    )


def handle_register_dataset_version() -> Response:
    """Register a version released outside the server, e.g. by the CLI."""
    record = request.get_json(force=True, silent=True) or {}
    return jsonify({"version": registry.register_dataset_version(_get_store(), record)})


def _check_repo_idle(store: Any, repo: Path) -> None:
    """Raise if a check or release job is still active in the repository."""
    for job in registry.list_release_jobs(store, limit=50):
        job = _expire_stale_job(store, job)
        if job["repo"] == str(repo) and job["status"] in registry.JOB_ACTIVE:
            raise MlflowException(
                f"job {job['job_id']} ({job['name']} {job['version']}) is still {job['status']} "
                f"in {repo}",
                error_code=INVALID_PARAMETER_VALUE,
            )


def handle_create_dataset() -> Response:
    """Register a new dataset and write its ``metadata.yaml`` template."""
    body = request.get_json(force=True, silent=True) or {}
    name = str(body.get("name") or "").strip()
    source = str(body.get("source") or "").strip()
    metrics = body.get("metrics") or []
    if NAME_PATTERN.match(name) is None:
        raise MlflowException(
            "name must start with a lowercase letter and hold only lowercase letters, digits "
            "and hyphens",
            error_code=INVALID_PARAMETER_VALUE,
        )
    if not source:
        raise MlflowException("source is required", error_code=INVALID_PARAMETER_VALUE)
    if not isinstance(metrics, list) or not all(
        isinstance(metric, str) and metric.strip() for metric in metrics
    ):
        raise MlflowException(
            "metrics must be a list of metric names", error_code=INVALID_PARAMETER_VALUE
        )

    store = _get_store()
    dataset = Dataset(find_repo(str(body.get("repo") or "")), name)
    on_disk = {found.name for repo in find_repos() for found in find_datasets(repo)}
    if dataset.root.exists() or name in on_disk | registry.list_dataset_changelogs(store).keys():
        raise MlflowException(f"dataset {name!r} already exists", error_code=RESOURCE_ALREADY_EXISTS)
    entry = registry.create_dataset(store, name, str(dataset.repo))
    try:
        dataset.root.mkdir(parents=True)
        write_metadata(
            dataset.metadata_path,
            build_metadata_template(name, source, [metric.strip() for metric in metrics]),
        )
    except OSError as error:
        registry.delete_dataset(store, name)
        raise MlflowException(
            f"could not create {dataset.root}: {error}", error_code=INVALID_PARAMETER_VALUE
        ) from error
    return jsonify({"dataset": build_dataset_summary(dataset, [], entry)})


def handle_delete_dataset(name: str) -> Response:
    """Delete a dataset that was never released: its directory and its registration."""
    store = _get_store()
    if registry.list_dataset_versions(store, name):
        raise MlflowException(
            f"dataset {name!r} has released versions; archive it instead",
            error_code=INVALID_PARAMETER_VALUE,
        )
    try:
        dataset = find_dataset(name)
    except MlflowException:
        dataset = None
    if dataset is not None:
        _check_repo_idle(store, dataset.repo)
        if read_metadata(dataset.metadata_path).get("version"):
            raise MlflowException(
                f"dataset {name!r} carries a release that is not registered yet; finish it first",
                error_code=INVALID_PARAMETER_VALUE,
            )
        shutil.rmtree(dataset.root)
    elif registry.get_dataset(store, name) is None:
        raise MlflowException(f"unknown dataset {name!r}", error_code=RESOURCE_DOES_NOT_EXIST)
    registry.delete_dataset(store, name)
    return jsonify({"deleted": name})


def handle_archive_dataset(name: str) -> Response:
    """Archive a released dataset: remove its directory and mark it archived."""
    store = _get_store()
    versions = registry.list_dataset_versions(store, name)
    entry = registry.get_dataset(store, name)
    if not versions:
        raise MlflowException(
            f"dataset {name!r} was never released; delete it instead",
            error_code=INVALID_PARAMETER_VALUE,
        )
    if entry and entry["archived"]:
        raise MlflowException(
            f"dataset {name!r} is already archived", error_code=INVALID_PARAMETER_VALUE
        )
    dataset = find_dataset(name)
    _check_repo_idle(store, dataset.repo)
    latest = max(versions, key=lambda row: parse_version(row["version"]))
    try:
        release_archive(
            dataset.repo,
            name,
            latest["version"],
            skip_hooks=os.environ.get(SKIP_HOOKS_ENV_VAR, "").lower() == "true",
            log=lambda line: None,
        )
    except ReleaseError as error:
        raise MlflowException(str(error), error_code=INVALID_PARAMETER_VALUE) from error
    return jsonify(
        {"dataset": registry.update_dataset_archived(store, name, True, str(dataset.repo))}
    )


def handle_unarchive_dataset(name: str) -> Response:
    """Undo an archive: restore the directory from the latest release and unmark it."""
    store = _get_store()
    entry = registry.get_dataset(store, name)
    if not entry or not entry["archived"]:
        raise MlflowException(
            f"dataset {name!r} is not archived", error_code=INVALID_PARAMETER_VALUE
        )
    versions = [
        row for row in registry.list_dataset_versions(store, name) if row["git_commit"]
    ]
    if not versions:
        raise MlflowException(
            f"dataset {name!r} has no release to restore from",
            error_code=INVALID_PARAMETER_VALUE,
        )
    repo = find_repo(entry["repo"] or "")
    _check_repo_idle(store, repo)
    latest = max(versions, key=lambda row: parse_version(row["version"]))
    try:
        restored = release_unarchive(
            repo,
            name,
            latest["git_commit"],
            skip_hooks=os.environ.get(SKIP_HOOKS_ENV_VAR, "").lower() == "true",
            log=lambda line: None,
        )
    except ReleaseError as error:
        raise MlflowException(str(error), error_code=INVALID_PARAMETER_VALUE) from error
    return jsonify(
        {
            "dataset": registry.update_dataset_archived(store, name, False, str(repo)),
            "data_restored": restored,
        }
    )


def handle_start_dataset_release(name: str) -> Response:
    """Start a check or a release of one dataset and return its job."""
    body = request.get_json(force=True, silent=True) or {}
    version = str(body.get("version") or "").strip()
    change = str(body.get("change") or "").strip()
    deletions = body.get("deletions") or []
    if not version or not change:
        raise MlflowException("version and change are required", error_code=INVALID_PARAMETER_VALUE)
    if not isinstance(deletions, list) or not set(deletions) <= set(UNITS):
        raise MlflowException(
            f"deletions must be a list drawn from {', '.join(UNITS)}",
            error_code=INVALID_PARAMETER_VALUE,
        )

    store = _get_store()
    dataset = find_dataset(name)
    for job in registry.list_release_jobs(store, limit=50):
        _expire_stale_job(store, job)
    job = registry.create_release_job(
        store, str(dataset.repo), name, version, change, bool(body.get("dry_run")), deletions
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
    ("/datasets", handle_create_dataset, "POST"),
    ("/datasets/versions", handle_register_dataset_version, "POST"),
    ("/datasets/<path:name>/versions", handle_list_dataset_versions, "GET"),
    ("/datasets/<path:name>/releases", handle_start_dataset_release, "POST"),
    ("/datasets/<path:name>/archive", handle_archive_dataset, "POST"),
    ("/datasets/<path:name>/unarchive", handle_unarchive_dataset, "POST"),
    ("/datasets/<path:name>", handle_delete_dataset, "DELETE"),
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
