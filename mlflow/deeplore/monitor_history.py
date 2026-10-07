"""Repair verified epoch-based monitor histories within the tracking store.

Sections: Validation, History, Maintenance.
Naming table: ``validate_*`` checks plans, ``read_*`` reads stored points, and
``rewrite_*`` applies an explicitly supplied epoch-to-step mapping.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import INVALID_PARAMETER_VALUE
from mlflow.store.tracking.dbmodels.models import (
    SqlLatestMetric,
    SqlLoggedModelMetric,
    SqlMetric,
    SqlRun,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from mlflow.store.tracking.sqlalchemy_store import SqlAlchemyStore

# ===== Validation =====

_Point = tuple[int, int, float, bool]
_MODEL_KEY = re.compile(
    r"^(train(ing)?|val(idation)?|valid|best(_ckpt|_checkpoint)?|lr|learning_rate|"
    r"loss|epoch|metrics|qat|quant(ization)?|early_stop|sparsification|sparsify)([/_]|$)"
)
_EXCLUDED_KEY = re.compile(
    r"(^|/)(system|batch|dra|benchmarks?([_-][^/]+)?|test|eval([_-][^/]+)?|"
    r"evaluations?|gpu|cpu|memory|mem)([/_]|$)"
)
_MAX_INTEGER = (1 << 63) - 1


def _invalid(message: str) -> MlflowException:
    return MlflowException(message, error_code=INVALID_PARAMETER_VALUE)


def _validate_step(value: Any, field: str) -> int:
    if type(value) is not int or not 0 <= value <= _MAX_INTEGER:
        raise _invalid(f"{field} must be a nonnegative 64-bit integer")
    return value


def _validate_plan(
    plan: dict[str, Any],
) -> tuple[str, str, list[_Point], dict[int, int]]:
    if not isinstance(plan, dict):
        raise _invalid("Each plan must be a dictionary")
    run_id, key = plan.get("run_id"), plan.get("metric_key")
    if not isinstance(run_id, str) or not run_id or run_id != run_id.strip():
        raise _invalid("run_id must be a nonempty run identifier")
    if not isinstance(key, str) or not _MODEL_KEY.match(key) or _EXCLUDED_KEY.search(key):
        raise _invalid(f"Metric {key!r} is not an eligible model monitor metric")

    mapping = plan.get("epoch_steps")
    if not isinstance(mapping, dict) or not mapping:
        raise _invalid(f"{run_id}/{key}: epoch_steps must be a nonempty dictionary")
    epoch_steps = {}
    for epoch, step in mapping.items():
        if not isinstance(epoch, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", epoch):
            raise _invalid("epoch_steps keys must be canonical nonnegative integer strings")
        epoch_steps[_validate_step(int(epoch), "epoch")] = _validate_step(step, "step")

    history = plan.get("expected_history")
    if not isinstance(history, list) or not history:
        raise _invalid(f"{run_id}/{key}: expected_history must contain the complete history")
    points = []
    for point in history:
        if not isinstance(point, dict):
            raise _invalid("Each expected_history point must be a dictionary")
        step = _validate_step(point.get("step"), "history step")
        timestamp, value = point.get("timestamp"), point.get("value")
        if type(timestamp) is not int or not -_MAX_INTEGER - 1 <= timestamp <= _MAX_INTEGER:
            raise _invalid("History timestamp must be a 64-bit integer")
        if type(value) not in (int, float):
            raise _invalid("History value must be numeric")
        try:
            value = float(value)
        except OverflowError as error:
            raise _invalid("History value exceeds the stored numeric range") from error
        if math.isinf(value):
            raise _invalid("History values must match the API's stored finite or NaN values")
        if step not in epoch_steps:
            raise _invalid(f"{run_id}/{key}: epoch_steps has no mapping for step {step}")
        is_nan = math.isnan(value)
        points.append((step, timestamp, 0.0 if is_nan else value, is_nan))
    return run_id, key, points, epoch_steps


# ===== History =====


def _read_history(session: Session, run_id: str, key: str) -> list[_Point]:
    return [
        tuple(row)
        for row in session.execute(
            select(SqlMetric.step, SqlMetric.timestamp, SqlMetric.value, SqlMetric.is_nan)
            .where(SqlMetric.run_uuid == run_id, SqlMetric.key == key)
            .order_by(SqlMetric.step, SqlMetric.timestamp, SqlMetric.value, SqlMetric.is_nan)
            .with_for_update()
        )
    ]


def _read_latest(session: Session, run_id: str, key: str) -> _Point | None:
    row = session.execute(
        select(
            SqlLatestMetric.step,
            SqlLatestMetric.timestamp,
            SqlLatestMetric.value,
            SqlLatestMetric.is_nan,
        )
        .where(SqlLatestMetric.run_uuid == run_id, SqlLatestMetric.key == key)
        .with_for_update()
    ).first()
    return tuple(row) if row is not None else None


def _point_record(point: _Point | None) -> dict[str, Any] | None:
    if point is None:
        return None
    step, timestamp, value, is_nan = point
    return {"step": step, "timestamp": timestamp, "value": math.nan if is_nan else value}


# ===== Maintenance =====


def rewrite_monitor_steps(
    store: SqlAlchemyStore, plans: list[dict[str, Any]], *, dry_run: bool = True
) -> dict[str, Any]:
    """Rewrite completed runs' verified monitor steps in one transaction.

    Args:
        store: The tracking server's SQL store, which owns these histories.
        plans: One entry per run and metric, with ``run_id``, ``metric_key``,
            ``expected_history`` (complete API points containing step, timestamp,
            value), and ``epoch_steps`` (string epochs mapped to integer steps).
            Callers must back up histories and establish exact mappings first.
        dry_run: Validate and return the proposed changes without writing data.

    Returns:
        Counts and per-metric changes, including previous and proposed latest
        points. Metric values and timestamps retain their original precision.

    Raises:
        MlflowException: If a plan is invalid, a run has not ended, the complete
            history differs from its backup, a mapping collides, or a metric
            belongs to a logged model. Any failed write rolls back all plans.
    """
    if not isinstance(plans, list) or type(dry_run) is not bool:
        raise _invalid("plans must be a list and dry_run must be a boolean")
    validated = [_validate_plan(plan) for plan in plans]
    identities = [(run_id, key) for run_id, key, _, _ in validated]
    if len(set(identities)) != len(identities):
        raise _invalid("Each run and metric may appear in only one plan")

    reports = []
    prepared = []
    with store.ManagedSessionMaker() as session:
        # Lock in a stable order and finish every precondition before any write.
        for run_id, key, expected, mapping in sorted(validated, key=lambda plan: plan[:2]):
            run = session.execute(
                select(SqlRun.status, SqlRun.end_time)
                .where(SqlRun.run_uuid == run_id)
                .with_for_update()
            ).first()
            if (
                run is None
                or run.status not in {"FINISHED", "FAILED", "KILLED"}
                or run.end_time is None
            ):
                raise _invalid(f"{run_id}: run must exist and have ended")
            linked_model = session.execute(
                select(SqlLoggedModelMetric.model_id)
                .where(
                    SqlLoggedModelMetric.run_id == run_id,
                    SqlLoggedModelMetric.metric_name == key,
                )
                .limit(1)
            ).first()
            if linked_model is not None:
                raise _invalid(
                    f"{run_id}/{key}: metric belongs to logged model {linked_model.model_id}"
                )
            history = _read_history(session, run_id, key)
            if Counter(history) != Counter(expected):
                raise _invalid(f"{run_id}/{key}: complete history differs from expected_history")
            rewritten = [
                (mapping[step], timestamp, value, is_nan)
                for step, timestamp, value, is_nan in history
            ]
            if len(set(rewritten)) != len(history):
                raise _invalid(
                    f"{run_id}/{key}: mapped steps would collide with an existing metric point"
                )
            previous = _read_latest(session, run_id, key)
            latest = max(rewritten, key=lambda point: point[:3])
            # Preserve MLflow's existing choice when NaN and zero tie for latest.
            mapped_previous = (mapping[previous[0]], *previous[1:]) if previous in history else None
            if mapped_previous is not None and mapped_previous[:3] == latest[:3]:
                latest = mapped_previous
            changed = sum(before[0] != after[0] for before, after in zip(history, rewritten))
            reports.append(
                {
                    "run_id": run_id,
                    "metric_key": key,
                    "history_count": len(history),
                    "changed_points": changed,
                    "latest_before": _point_record(previous),
                    "latest_after": _point_record(latest),
                    "latest_changed": previous != latest,
                }
            )
            prepared.append((run_id, key, rewritten, changed, previous, latest))

        if not dry_run:
            for run_id, key, rewritten, changed, previous, latest in prepared:
                if changed:
                    # Replace the checked history atomically to avoid transient PK collisions.
                    result = session.execute(
                        SqlMetric.__table__.delete().where(
                            SqlMetric.run_uuid == run_id, SqlMetric.key == key
                        )
                    )
                    if result.rowcount != len(rewritten):
                        raise _invalid(f"{run_id}/{key}: history changed during the rewrite")
                    session.execute(
                        SqlMetric.__table__.insert(),
                        [
                            {
                                "run_uuid": run_id,
                                "key": key,
                                "step": step,
                                "timestamp": timestamp,
                                "value": value,
                                "is_nan": is_nan,
                            }
                            for step, timestamp, value, is_nan in rewritten
                        ],
                    )
                if previous != latest:
                    step, timestamp, value, is_nan = latest
                    values = {
                        "step": step,
                        "timestamp": timestamp,
                        "value": value,
                        "is_nan": is_nan,
                    }
                    if previous is None:
                        session.execute(
                            SqlLatestMetric.__table__.insert().values(
                                run_uuid=run_id, key=key, **values
                            )
                        )
                    else:
                        session.execute(
                            SqlLatestMetric.__table__.update()
                            .where(SqlLatestMetric.run_uuid == run_id, SqlLatestMetric.key == key)
                            .values(**values)
                        )
                if Counter(_read_history(session, run_id, key)) != Counter(rewritten):
                    raise _invalid(f"{run_id}/{key}: rewritten history failed verification")
                if _read_latest(session, run_id, key) != latest:
                    raise _invalid(f"{run_id}/{key}: latest metric failed verification")

    return {
        "dry_run": dry_run,
        "metric_count": len(reports),
        "history_count": sum(report["history_count"] for report in reports),
        "changed_points": sum(report["changed_points"] for report in reports),
        "plans": reports,
    }
