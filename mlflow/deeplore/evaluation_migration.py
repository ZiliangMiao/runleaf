"""Import legacy benchmark tables through the tracking server's public APIs.

Sections: Transport, Discovery, Conversion, Migration, Entry point.
The default is a dry run. Source tables remain unchanged, and each imported
row retains its original content and position for idempotent verification.

Naming table: ``read_*`` fetches data, ``build_*`` converts it, and ``run_*``
executes an audit or migration. No model or dataset files are downloaded.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urljoin
from urllib.request import Request, urlopen


# ===== Transport =====


def read_response(
    tracking_uri: str, endpoint: str, payload: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Read a JSON API response, including structured errors.

    Args:
        tracking_uri: Tracking server origin.
        endpoint: API endpoint or an absolute artifact URL.
        payload: Optional JSON request body.

    Returns:
        Parsed response object.

    Raises:
        RuntimeError: If the server rejects the request.
    """
    url = urljoin(tracking_uri.rstrip("/") + "/", endpoint)
    body = (
        json.dumps(payload, allow_nan=False).encode() if payload is not None else None
    )
    request = Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=120) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {error.code} from {endpoint}: {detail}") from error


# ===== Discovery =====


def read_runs(tracking_uri: str) -> list[dict[str, Any]]:
    """Read all historical runs without changing deleted run state."""
    experiments: list[dict[str, Any]] = []
    query: dict[str, Any] = {"max_results": 1000, "view_type": "ALL"}
    while True:
        response = read_response(
            tracking_uri, "/api/2.0/mlflow/experiments/search", query
        )
        experiments.extend(response.get("experiments", []))
        if not response.get("next_page_token"):
            break
        query["page_token"] = response["next_page_token"]

    runs: list[dict[str, Any]] = []
    for experiment in experiments:
        query = {
            "experiment_ids": [experiment["experiment_id"]],
            "max_results": 1000,
            "run_view_type": "ALL",
        }
        while True:
            response = read_response(tracking_uri, "/api/2.0/mlflow/runs/search", query)
            for run in response.get("runs", []):
                run["experiment_name"] = experiment["name"]
                runs.append(run)
            if not response.get("next_page_token"):
                break
            query["page_token"] = response["next_page_token"]
    return runs


def read_artifacts(tracking_uri: str, run_id: str, parent: Path) -> set[str]:
    """List the existing files in one run artifact directory."""
    query = urlencode(
        {"run_id": run_id, "path": "" if parent == Path(".") else parent.as_posix()}
    )
    response = read_response(tracking_uri, "/api/2.0/mlflow/artifacts/list?" + query)
    return {
        item["path"] for item in response.get("files", []) if not item.get("is_dir")
    }


def read_table(
    tracking_uri: str, run: dict[str, Any], artifact: Path
) -> list[dict[str, Any]]:
    """Read a registered table through its owning run's artifact service."""
    url = urljoin(
        run["info"]["artifact_uri"].rstrip("/") + "/",
        quote(artifact.as_posix(), safe="/"),
    )
    table = read_response(tracking_uri, url)
    columns, data = table.get("columns"), table.get("data")
    if not isinstance(columns, list) or not isinstance(data, list):
        raise ValueError(f"Invalid table structure: {artifact}")
    if len(set(columns)) != len(columns):
        raise ValueError(f"Duplicate table columns: {artifact}")
    rows = []
    for row in data:
        if not isinstance(row, list) or len(row) != len(columns):
            raise ValueError(f"Invalid table row: {artifact}")
        rows.append(dict(zip(columns, row)))
    return rows


# ===== Conversion =====


BENCHMARK_ALIASES = {
    "test": "inat-normal",
    "hard": "inat-hard",
    "background": "fulldive-bg",
}
BENCHMARK_RENAME_COMMIT = "3f547cad771bb10468d93ca5c20c5fcc7532eb98"
METRIC_NAMES = frozenset(
    {
        "AP",
        "AP_50",
        "AP_75",
        "AP_s",
        "AP_m",
        "AP_l",
        "AR_1",
        "AR_10",
        "AR_100",
        "class_agnostic_AP",
        "FPPF",
        "precision",
        "recall",
        "F1",
        "leakage_rate",
        "loss",
        "acc1",
        "acc3",
        "acc5",
        "accuracy",
        "macro_precision",
        "macro_recall",
        "macro_f1",
        "macro_f1_all_classes",
        "micro_f1",
        "weighted_f1",
    }
)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _digest(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    content = value.removesuffix(".dir")
    if len(content) not in (32, 64) or any(
        character not in "0123456789abcdefABCDEF" for character in content
    ):
        return None
    return value


def _build_dataset_identity(
    run: dict[str, Any], row: dict[str, Any], benchmark: str, reasons: dict[str, str]
) -> tuple[str | None, str | None, str | None, dict[str, Any]]:
    test_hash = _digest(row.get("benchmark_md5")) or _digest(row.get("dataset_md5"))
    version = _text(row.get("benchmark_version")) or _text(row.get("dataset_version"))
    if run["experiment_name"].startswith("deepdet-"):
        name = BENCHMARK_ALIASES.get(benchmark, benchmark)
        evidence: dict[str, Any] = {
            "source": "benchmark_history",
            "benchmark_name": benchmark,
        }
        if name != benchmark:
            evidence["rename_commit"] = BENCHMARK_RENAME_COMMIT
        if version is None:
            reasons["dataset_version"] = (
                "The original evaluation and surviving report did not record a dataset version."
            )
        if test_hash is None:
            reasons["test_hash"] = (
                "The original evaluation did not record a complete test content hash."
            )
        return name, version, test_hash, evidence

    candidates: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in run.get("inputs", {}).get("dataset_inputs", []):
        dataset = item.get("dataset", {})
        tags = {tag["key"]: tag["value"] for tag in item.get("tags", [])}
        if tags.get("mlflow.data.context") != "evaluation":
            continue
        candidate_version = tags.get("version") or tags.get("test_version")
        if not candidate_version or (version and version != candidate_version):
            continue
        candidate_hash = _digest(tags.get("split_md5"))
        if candidate_hash and test_hash and candidate_hash != test_hash:
            continue
        name = dataset.get("name")
        if name:
            candidates.setdefault((name, candidate_version), []).append(
                {"source": "run_dataset_input", "dataset": dataset, "tags": tags}
            )
    if len(candidates) == 1:
        (name, version), matches = next(iter(candidates.items()))
        evidence = {"source": "run_dataset_input", "matches": matches}
        hashes = {_digest(match["tags"].get("split_md5")) for match in matches}
        if test_hash is None and len(hashes) == 1:
            test_hash = next(iter(hashes))
    else:
        name, version, evidence = None, None, {"candidate_count": len(candidates)}
        reasons["dataset_name"] = (
            "The original evaluation could not be matched to one historical evaluation dataset input."
        )
        reasons["dataset_version"] = reasons["dataset_name"]
    if test_hash is None:
        reasons["test_hash"] = (
            "The original evaluation did not record a complete test content hash."
        )
    return name, version, test_hash, evidence


def _build_checkpoint(
    row: dict[str, Any], checkpoint_files: set[str], reasons: dict[str, str]
) -> tuple[str | None, str | None, str | None]:
    source = _text(row.get("checkpoint")) or _text(row.get("ckpt_path"))
    candidate = None
    if source:
        basename = Path(source).name
        if basename in ("best_ckpt", "best_ckpt.pth"):
            candidate = Path("checkpoints") / "best_ckpt.pth"
        elif basename == "best.pt":
            candidate = Path("checkpoints") / "best.pt"
    elif row.get("checkpoint_md5"):
        candidate = Path("checkpoints") / "best.pt"
    checkpoint_path = (
        candidate.as_posix()
        if candidate and candidate.as_posix() in checkpoint_files
        else None
    )
    if checkpoint_path is None:
        reasons["ckpt_path"] = (
            "No matching best checkpoint artifact exists in this run; the original model reference is preserved."
        )

    checkpoint_hash = None
    for field, length in (("checkpoint_md5", 32), ("checkpoint_sha256", 64)):
        value = _digest(row.get(field))
        if value is not None and len(value) == length:
            checkpoint_hash = value
            break
    if (
        checkpoint_hash is None
        and checkpoint_path == "checkpoints/best.pt"
        and source
        and Path(source).suffix == ".pt"
    ):
        value = _digest(row.get("model_sha256"))
        if value is not None and len(value) == 64:
            checkpoint_hash = value
    if checkpoint_hash is None:
        reasons["ckpt_hash"] = (
            "The historical evaluation did not record the training checkpoint content hash; a current file hash would not prove historical identity."
        )
    algorithm = (
        ("md5" if len(checkpoint_hash) == 32 else "sha256") if checkpoint_hash else None
    )
    return checkpoint_path, checkpoint_hash, algorithm


def _build_evaluation_time(row: dict[str, Any], reasons: dict[str, str]) -> int | None:
    raw = _text(row.get("timestamp"))
    if raw:
        try:
            value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if value.tzinfo is not None:
                return int(value.timestamp() * 1000)
        except ValueError:
            pass
        reasons["evaluated_at"] = (
            "The original timestamp has no verified timezone or is invalid; its exact text is retained in the source row."
        )
    else:
        reasons["evaluated_at"] = (
            "The original evaluation did not record its execution time."
        )
    return None


def build_evaluation(
    run: dict[str, Any],
    source_artifact: Path,
    source_row: int,
    row: dict[str, Any],
    checkpoint_files: set[str],
) -> dict[str, Any]:
    """Convert one legacy row without inventing missing provenance.

    Args:
        run: Owning run and its historical dataset inputs.
        source_artifact: Original registered table path.
        source_row: Zero-based original row position.
        row: Exact original column-value mapping.
        checkpoint_files: Existing checkpoint artifact paths.

    Returns:
        An import payload retaining the exact source row.
    """
    benchmark = source_artifact.stem
    reasons: dict[str, str] = {}
    name, version, test_hash, evidence = _build_dataset_identity(
        run, row, benchmark, reasons
    )
    checkpoint_path, checkpoint_hash, algorithm = _build_checkpoint(
        row, checkpoint_files, reasons
    )
    metrics = {
        key: value
        for key, value in row.items()
        if (key in METRIC_NAMES or key.startswith("per_class_AP/"))
        and (value is None or (type(value) in (int, float) and math.isfinite(value)))
    }
    # Precision is a numeric metric in old detector rows and a dtype in classifier rows.
    report = _text(row.get("artifact_path"))
    return {
        "dataset_name": name,
        "dataset_version": version,
        "benchmark_name": benchmark,
        "test_hash": test_hash,
        "ckpt_path": checkpoint_path,
        "ckpt_hash": checkpoint_hash,
        "ckpt_hash_algorithm": algorithm,
        "evaluated_at": _build_evaluation_time(row, reasons),
        "metrics": metrics,
        "artifact_path": report,
        "source_artifact": source_artifact.as_posix(),
        "source_row": source_row,
        "metadata": {
            "original_record": row,
            "incomplete_reasons": reasons,
            "dataset_resolution": evidence,
            "source_run_lifecycle_stage": run["info"].get("lifecycle_stage"),
        },
    }


# ===== Migration =====


def run_migration(tracking_uri: str, *, apply: bool = False) -> dict[str, Any]:
    """Audit or import every registered benchmark history table.

    Args:
        tracking_uri: Tracking server URL.
        apply: Whether to insert records after conversion.

    Returns:
        Counts, source digests, and any errors for independent verification.
    """
    runs = read_runs(tracking_uri)
    report: dict[str, Any] = {
        "tracking_uri": tracking_uri,
        "apply": apply,
        "runs_scanned": len(runs),
        "tables": 0,
        "rows": 0,
        "created": 0,
        "existing": 0,
        "pending": 0,
        "errors": [],
        "records": [],
    }
    for run in runs:
        run_id = run["info"]["run_id"]
        tags = {
            item["key"]: item["value"] for item in run.get("data", {}).get("tags", [])
        }
        artifacts = json.loads(tags.get("mlflow.loggedArtifacts", "[]"))
        tables = [
            Path(item["path"])
            for item in artifacts
            if item.get("type") == "table"
            and Path(item["path"]).parent == Path("eval_history")
        ]
        if not tables:
            continue
        checkpoint_files = read_artifacts(tracking_uri, run_id, Path("checkpoints"))
        for table in tables:
            try:
                rows = read_table(tracking_uri, run, table)
            except Exception as error:
                report["errors"].append(
                    {
                        "run_id": run_id,
                        "source_artifact": table.as_posix(),
                        "error": str(error),
                    }
                )
                continue
            report["tables"] += 1
            for index, row in enumerate(rows):
                report["rows"] += 1
                try:
                    record = build_evaluation(run, table, index, row, checkpoint_files)
                    pending = (
                        record["dataset_name"] is None
                        or record["dataset_version"] is None
                    )
                    report["pending"] += int(pending)
                    raw = json.dumps(
                        row, allow_nan=False, sort_keys=True, separators=(",", ":")
                    )
                    entry = {
                        "run_id": run_id,
                        "run_name": run["info"].get("run_name"),
                        "source_artifact": table.as_posix(),
                        "source_row": index,
                        "source_digest": hashlib.sha256(raw.encode()).hexdigest(),
                        "dataset_name": record["dataset_name"],
                        "dataset_version": record["dataset_version"],
                        "pending": pending,
                        "incomplete_reasons": record["metadata"]["incomplete_reasons"],
                    }
                    if apply:
                        response = read_response(
                            tracking_uri,
                            f"/api/2.0/deeplore/runs/{quote(run_id)}/evaluations/import",
                            record,
                        )
                        report["created" if response["created"] else "existing"] += 1
                        saved = response["evaluation"]
                        if (
                            saved["metadata"]["original_record"] != row
                            or saved["metrics"] != record["metrics"]
                        ):
                            raise RuntimeError(
                                "Stored content differs from the original evaluation"
                            )
                        entry["evaluation_id"] = saved["evaluation_id"]
                    report["records"].append(entry)
                except Exception as error:
                    report["errors"].append(
                        {
                            "run_id": run_id,
                            "source_artifact": table.as_posix(),
                            "source_row": index,
                            "error": str(error),
                        }
                    )
    report["missing_fields"] = dict(
        Counter(key for item in report["records"] for key in item["incomplete_reasons"])
    )
    return report


# ===== Entry point =====


def main() -> None:
    """Run the migration and optionally save its machine-local audit report."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tracking-uri", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path)
    arguments = parser.parse_args()
    if arguments.report and not arguments.report.resolve().is_relative_to(
        Path("/data/Projects/mlflow/.local").resolve()
    ):
        parser.error("Migration reports belong under /data/Projects/mlflow/.local")
    report = run_migration(arguments.tracking_uri, apply=arguments.apply)
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n"
        )
        arguments.report.chmod(arguments.report.stat().st_mode | 0o666)
    summary = {key: value for key, value in report.items() if key != "records"}
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
