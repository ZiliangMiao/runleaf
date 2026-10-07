"""Experiment benchmark catalog and results from database evaluations.

Sections: Catalog, Runs, Results, Handler. Catalog entries are dataset test
hashes. Results and run identities always belong to the requested experiment.

Naming table: ``build_*`` constructs responses and ``handle_*`` serves requests.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import sqlalchemy
from flask import Response, jsonify
from sqlalchemy.orm import aliased

from mlflow.deeplore import dataset_registry, evaluation_registry
from mlflow.deeplore.dataset_api import build_dataset_summary, find_repos
from mlflow.deeplore.dataset_release import find_datasets, parse_hashes, parse_version
from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE
from mlflow.store.tracking.dbmodels.models import (
    SqlDataset,
    SqlInput,
    SqlInputTag,
    SqlRun,
    SqlTag,
)

if TYPE_CHECKING:
    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

# ===== Catalog =====


def _get_group(
    groups: dict[tuple[str, str], dict[str, Any]], name: str, content_hash: str
) -> dict[str, Any]:
    return groups.setdefault(
        (name, content_hash),
        {
            "dataset_name": name,
            "test_hash": content_hash,
            "dataset_versions": set(),
            "metric_names": set(),
            "evaluations": [],
        },
    )


def _add_dataset(
    groups: dict[tuple[str, str], dict[str, Any]],
    name: str,
    version: Any,
    content_hash: Any,
    metadata: dict[str, Any],
) -> None:
    if (
        not isinstance(version, str)
        or not version
        or not isinstance(content_hash, str)
        or re.fullmatch(r"[0-9a-fA-F]{32}(?:\.dir)?", content_hash) is None
    ):
        return
    group = _get_group(groups, name, content_hash.lower())
    group["dataset_versions"].add(version)
    metrics = metadata.get("metrics")
    if isinstance(metrics, list):
        group["metric_names"].update(
            metric
            for metric in metrics
            if isinstance(metric, str)
            and metric
            and metric not in ("per_class_AP", "per_class_AP/")
            and "*" not in metric
        )


def _build_catalog(store: SqlAlchemyStore) -> dict[tuple[str, str], dict[str, Any]]:
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for version in dataset_registry.list_dataset_versions(store):
        _add_dataset(
            groups,
            version["name"],
            version["version"],
            version["hashes"].get("test"),
            version["metadata"],
        )
    for repository in find_repos():
        for dataset in find_datasets(repository):
            metadata = build_dataset_summary(dataset, []).get("metadata") or {}
            _add_dataset(
                groups,
                dataset.name,
                metadata.get("version"),
                parse_hashes(metadata).get("test"),
                metadata,
            )
    return groups


def _build_historical_versions(
    store: SqlAlchemyStore, groups: dict[tuple[str, str], dict[str, Any]]
) -> dict[tuple[str, str], set[str]]:
    registered_hashes = {
        (row["name"], row["version"]): row["hashes"]["test"].lower()
        for row in dataset_registry.list_dataset_versions(store)
        if isinstance(row["hashes"].get("test"), str) and row["hashes"]["test"]
    }
    with evaluation_registry._session(store) as session:
        evaluation = evaluation_registry.SqlEvaluation
        identities = [
            (row.dataset_name, row.dataset_version, row.test_hash)
            for row in session.execute(
                sqlalchemy.select(evaluation).where(
                    evaluation.association_status == "confirmed"
                )
            ).scalars()
        ]
        context = aliased(SqlInputTag)
        split = aliased(SqlInputTag)
        identities.extend(
            session.execute(
                sqlalchemy.select(SqlDataset.name, SqlInputTag.value, split.value)
                .join(SqlInput, SqlInput.source_id == SqlDataset.dataset_uuid)
                .join(SqlInputTag, SqlInputTag.input_uuid == SqlInput.input_uuid)
                .join(context, context.input_uuid == SqlInput.input_uuid)
                .join(split, split.input_uuid == SqlInput.input_uuid)
                .where(
                    SqlInput.source_type == "DATASET",
                    SqlInput.destination_type == "RUN",
                    SqlInputTag.name.in_(("version", "test_version")),
                    context.name == "mlflow.data.context",
                    context.value == "evaluation",
                    split.name == "split_md5",
                )
                .distinct()
            )
        )
    versions: dict[tuple[str, str], set[str]] = {}
    for name, version, content_hash in identities:
        if not isinstance(version, str) or not version or not content_hash:
            continue
        key = (name, content_hash.lower())
        if key not in groups:
            continue
        released_hash = registered_hashes.get((name, version))
        if released_hash is not None and released_hash != key[1]:
            continue
        versions.setdefault(key, set()).add(version)
    return versions


def _build_first_dataset_version(versions: list[str]) -> str | None:
    if len(versions) == 1:
        return versions[0]
    try:
        # Release versions advance monotonically; registration times may be imports.
        return min(versions, key=parse_version)
    except ValueError:
        return None


# ===== Runs =====


def _build_run(row: SqlRun, tags: dict[str, str]) -> dict[str, Any]:
    raw_number = tags.get("run_num", tags.get("run_seq", ""))
    number_match = re.fullmatch(r"r?([0-9]+)", raw_number)
    number = int(number_match.group(1)) if number_match else None
    if "run_num" in tags and "run_seq" in tags:
        if tags["run_num"] != tags["run_seq"]:
            raise MlflowException(
                f"Conflicting run_num and legacy run_seq for run {row.run_uuid}",
                INVALID_PARAMETER_VALUE,
            )
    return {
        "run_id": row.run_uuid,
        "run_name": row.name or tags.get("mlflow.runName") or row.run_uuid,
        "run_num": number if number is not None and number > 0 else None,
    }


# ===== Results =====


def build_benchmarks(store: SqlAlchemyStore, experiment_id: str) -> dict[str, Any]:
    """Build catalog groups and active run results for one experiment.

    Args:
        store: The tracking server's SQL store.
        experiment_id: Requested experiment identifier.

    Returns:
        Runs, including unevaluated runs, and groups keyed by dataset test hash.
    """
    experiment = store.get_experiment(experiment_id)
    groups = _build_catalog(store)
    with evaluation_registry._session(store) as session:
        run_query = sqlalchemy.select(SqlRun).where(
            SqlRun.experiment_id == experiment.experiment_id,
            SqlRun.lifecycle_stage == "active",
        )
        rows = list(session.execute(run_query).scalars())
        tags: dict[str, dict[str, str]] = {}
        query = (
            sqlalchemy.select(SqlTag)
            .join(SqlRun, SqlTag.run_uuid == SqlRun.run_uuid)
            .where(
                SqlRun.experiment_id == experiment.experiment_id,
                SqlRun.lifecycle_stage == "active",
                SqlTag.key.in_(("run_num", "run_seq", "mlflow.runName")),
            )
        )
        for tag in session.execute(query).scalars():
            tags.setdefault(tag.run_uuid, {})[tag.key] = tag.value
        runs = [_build_run(row, tags.get(row.run_uuid, {})) for row in rows]
        evaluation = evaluation_registry.SqlEvaluation
        query = (
            sqlalchemy.select(evaluation)
            .join(SqlRun, evaluation.run_id == SqlRun.run_uuid)
            .where(
                SqlRun.experiment_id == experiment.experiment_id,
                SqlRun.lifecycle_stage == "active",
                evaluation.association_status == "confirmed",
                evaluation.dataset_name.is_not(None),
            )
        )
        for row in session.execute(query).scalars():
            if row.test_hash is None:
                continue
            group = _get_group(groups, row.dataset_name, row.test_hash)
            group["dataset_versions"].add(row.dataset_version)
            result = row.to_dict()
            group["metric_names"].update(result["metrics"])
            group["evaluations"].append(result)

    runs.sort(
        key=lambda row: (row["run_num"] is None, row["run_num"] or 0, row["run_id"])
    )
    positions = {row["run_id"]: index for index, row in enumerate(runs)}
    historical_versions = _build_historical_versions(store, groups)
    benchmarks = []
    for key in sorted(groups):
        group = groups[key]
        group["dataset_versions"].update(historical_versions.get(key, set()))
        group["dataset_versions"] = sorted(group["dataset_versions"])
        group["first_dataset_version"] = _build_first_dataset_version(
            group["dataset_versions"]
        )
        group["metric_names"] = sorted(group["metric_names"])
        group["evaluations"].sort(
            key=lambda row: (positions[row["run_id"]], row["evaluation_id"])
        )
        benchmarks.append(group)
    return {
        "experiment_id": experiment.experiment_id,
        "runs": runs,
        "benchmarks": benchmarks,
    }


# ===== Handler =====


def handle_list_benchmarks(experiment_id: str) -> Response:
    """Return the requested experiment's benchmark catalog and evaluated runs."""
    from mlflow.deeplore.evaluation_api import _get_store

    return jsonify(build_benchmarks(_get_store(), experiment_id))
