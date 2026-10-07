"""Move evaluation test hashes into dataset versions while the server is stopped.

Sections: Schema, Inspection, Validation, Transactional migration, Command entry.
Naming: read_* inspects storage, validate_* checks invariants, build_* prepares
historical versions, migrate_* changes storage, and main runs the command.
The caller must back up the database before invoking this offline migration.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

# ===== Schema =====

DATASET_TABLE = "deeplore_dataset_versions"
EVALUATION_TABLE = "deeplore_evaluations"
DATASET_COLUMNS = (
    "name",
    "version",
    "change",
    "hashes",
    "metadata_json",
    "git_repo",
    "git_tag",
    "git_commit",
    "created_at",
)
EVALUATION_COLUMNS = (
    "evaluation_id",
    "run_id",
    "dataset_name",
    "dataset_version",
    "association_status",
    "benchmark_name",
    "checkpoint_path",
    "checkpoint_hash",
    "evaluation_time",
    "metrics",
    "params",
    "metadata_json",
    "created_at",
)
HISTORICAL_NULLABLE_COLUMNS = {"change", "git_repo", "git_tag", "git_commit"}
TIME_INDEX = "index_deeplore_evaluations_run_time"
OLD_IDENTITY_INDEX = "index_deeplore_evaluations_run_dataset_test"
IDENTITY_INDEX = "index_deeplore_evaluations_run_dataset_version"

DATASET_SCHEMA = """
CREATE TABLE deeplore_dataset_versions_migrating (
    name VARCHAR(256) NOT NULL,
    version VARCHAR(64) NOT NULL,
    change TEXT,
    hashes TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    git_repo VARCHAR(1024),
    git_tag VARCHAR(512),
    git_commit VARCHAR(64),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (name, version)
)
"""
EVALUATION_SCHEMA = """
CREATE TABLE deeplore_evaluations_migrating (
    evaluation_id VARCHAR(32) NOT NULL,
    run_id VARCHAR(32) NOT NULL,
    dataset_name VARCHAR(256),
    dataset_version VARCHAR(64),
    association_status VARCHAR(16) NOT NULL,
    benchmark_name VARCHAR(256) NOT NULL,
    checkpoint_path VARCHAR(1024),
    checkpoint_hash VARCHAR(32),
    evaluation_time BIGINT,
    metrics TEXT NOT NULL,
    params TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (evaluation_id),
    CONSTRAINT evaluation_association_status
        CHECK (association_status IN ('confirmed', 'pending')),
    CONSTRAINT evaluation_confirmed_identity
        CHECK (association_status != 'confirmed' OR
            (dataset_name IS NOT NULL AND dataset_version IS NOT NULL)),
    FOREIGN KEY (run_id) REFERENCES runs (run_uuid) ON DELETE CASCADE,
    CONSTRAINT evaluation_dataset_version FOREIGN KEY (dataset_name, dataset_version)
        REFERENCES deeplore_dataset_versions (name, version)
)
"""


# ===== Inspection =====


def _read_rows(connection: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    cursor = connection.execute(query)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor]


def _read_columns(connection: sqlite3.Connection, table: str) -> list[tuple[Any, ...]]:
    return [tuple(row) for row in connection.execute(f'PRAGMA table_info("{table}")')]


def _read_indexes(connection: sqlite3.Connection) -> dict[str, tuple[bool, list[str]]]:
    indexes = {}
    for row in connection.execute("PRAGMA index_list(deeplore_evaluations)"):
        if row[3] == "pk":
            continue
        if row[4]:
            raise ValueError("Unexpected partial evaluation index")
        columns = [
            column[2]
            for column in connection.execute(
                "SELECT * FROM pragma_index_info(?) ORDER BY seqno", (row[1],)
            )
        ]
        indexes[row[1]] = (bool(row[2]), columns)
    return indexes


def _read_visible_evaluations(
    connection: sqlite3.Connection, derived_hash: bool
) -> list[dict[str, Any]]:
    columns = ", ".join(f'evaluation."{name}"' for name in EVALUATION_COLUMNS)
    content_hash = (
        "json_extract(dataset.hashes, '$.test')"
        if derived_hash
        else "evaluation.dataset_hash"
    )
    return _read_rows(
        connection,
        f"SELECT {columns}, {content_hash} AS dataset_hash "
        "FROM deeplore_evaluations AS evaluation "
        "LEFT JOIN deeplore_dataset_versions AS dataset "
        "ON dataset.name = evaluation.dataset_name "
        "AND dataset.version = evaluation.dataset_version "
        "ORDER BY evaluation.evaluation_id",
    )


# ===== Validation =====


def _validate_dependencies(connection: sqlite3.Connection) -> None:
    for (table,) in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ):
        escaped = table.replace('"', '""')
        for foreign_key in connection.execute(f'PRAGMA foreign_key_list("{escaped}")'):
            if (
                foreign_key[2] in (DATASET_TABLE, EVALUATION_TABLE)
                and table != EVALUATION_TABLE
            ):
                raise ValueError(f"Unexpected referencing table: {table}")
    if connection.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?, ?)",
        (DATASET_TABLE, EVALUATION_TABLE),
    ).fetchone():
        raise ValueError(
            "Unexpected dataset or evaluation triggers require manual review"
        )
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Database contains foreign key violations")


def _validate_schema(connection: sqlite3.Connection, migrated: bool) -> None:
    dataset_columns = _read_columns(connection, DATASET_TABLE)
    evaluation_columns = _read_columns(connection, EVALUATION_TABLE)
    expected = set(EVALUATION_COLUMNS) | (set() if migrated else {"dataset_hash"})
    if set(row[1] for row in dataset_columns) != set(DATASET_COLUMNS):
        raise ValueError("Unexpected dataset version columns")
    if set(row[1] for row in evaluation_columns) != expected:
        raise ValueError("Unexpected evaluation columns")
    expected_indexes = {
        TIME_INDEX: (False, ["run_id", "evaluation_time"]),
        IDENTITY_INDEX if migrated else OLD_IDENTITY_INDEX: (
            True,
            [
                "run_id",
                "dataset_name",
                "dataset_version" if migrated else "dataset_hash",
            ],
        ),
    }
    if _read_indexes(connection) != expected_indexes:
        raise ValueError("Unexpected evaluation indexes")
    dataset_indexes = connection.execute("PRAGMA index_list(deeplore_dataset_versions)")
    if any(row[3] != "pk" for row in dataset_indexes):
        raise ValueError("Unexpected dataset version indexes require manual review")
    if migrated:
        if any(
            row[3] for row in dataset_columns if row[1] in HISTORICAL_NULLABLE_COLUMNS
        ):
            raise ValueError("Historical dataset fields are not nullable")
        foreign_keys = connection.execute(
            "PRAGMA foreign_key_list(deeplore_evaluations)"
        )
        definitions = {(row[2], row[3], row[4], row[6]) for row in foreign_keys}
        if definitions != {
            ("runs", "run_id", "run_uuid", "CASCADE"),
            (DATASET_TABLE, "dataset_name", "name", "NO ACTION"),
            (DATASET_TABLE, "dataset_version", "version", "NO ACTION"),
        }:
            raise ValueError("Evaluation dataset foreign key is missing or unexpected")


def _validate_records(
    records: list[dict[str, Any]], versions: dict[tuple[str, str], dict[str, Any]]
) -> None:
    identities: dict[tuple[str, str], str | None] = {}
    results: set[tuple[str, str, str]] = set()
    for row in records:
        name, version, content_hash = (
            row["dataset_name"],
            row["dataset_version"],
            row["dataset_hash"],
        )
        if row["association_status"] == "confirmed" and not all(
            (name, version, content_hash)
        ):
            raise ValueError(
                f"Confirmed evaluation cannot be associated: {row['evaluation_id']}"
            )
        if content_hash is not None:
            if not name or not version or not isinstance(content_hash, str):
                raise ValueError("Evaluation hash requires a dataset name and version")
            if re.fullmatch(r"[0-9a-fA-F]{32}(?:\.dir)?", content_hash) is None:
                raise ValueError(f"Incomplete dataset hash for {name!r} {version!r}")
            result = (row["run_id"], name, content_hash.lower())
            if result in results:
                raise ValueError(
                    "Duplicate evaluations for one run, dataset name and test hash"
                )
            results.add(result)
        if name is not None and version is not None:
            identity = (name, version)
            if identity in identities and identities[identity] != content_hash:
                raise ValueError(
                    f"Conflicting evaluation hashes for {name!r} {version!r}"
                )
            identities[identity] = content_hash
            if identity in versions:
                hashes = json.loads(versions[identity]["hashes"])
                if not isinstance(hashes, dict) or hashes.get("test") != content_hash:
                    raise ValueError(
                        f"Registered test hash conflicts for {name!r} {version!r}"
                    )
            elif content_hash is None:
                raise ValueError(
                    f"Cannot associate dataset version {name!r} {version!r}"
                )


def _build_historical_versions(
    connection: sqlite3.Connection,
    records: list[dict[str, Any]],
    versions: dict[tuple[str, str], dict[str, Any]],
) -> list[dict[str, Any]]:
    has_changelog = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deeplore_dataset_changelog'"
    ).fetchone()
    changes = (
        {
            (row[0], row[1]): row[2]
            for row in connection.execute(
                "SELECT name, version, change FROM deeplore_dataset_changelog"
            )
        }
        if has_changelog
        else {}
    )
    additions = {}
    registered_at = int(time.time() * 1000)
    for row in records:
        identity = (row["dataset_name"], row["dataset_version"])
        if None in identity or identity in versions:
            continue
        additions[identity] = {
            "name": identity[0],
            "version": identity[1],
            "change": changes.get(identity),
            "hashes": json.dumps({"test": row["dataset_hash"]}, separators=(",", ":")),
            "metadata_json": "{}",
            "git_repo": None,
            "git_tag": None,
            "git_commit": None,
            "created_at": registered_at,
        }
    return [additions[identity] for identity in sorted(additions)]


# ===== Transactional migration =====


def _migrate_tables(
    connection: sqlite3.Connection,
    records: list[dict[str, Any]],
    versions: list[dict[str, Any]],
) -> None:
    connection.execute(DATASET_SCHEMA)
    connection.executemany(
        "INSERT INTO deeplore_dataset_versions_migrating VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [tuple(row[name] for name in DATASET_COLUMNS) for row in versions],
    )
    connection.execute(EVALUATION_SCHEMA)
    connection.executemany(
        "INSERT INTO deeplore_evaluations_migrating VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [tuple(row[name] for name in EVALUATION_COLUMNS) for row in records],
    )
    connection.execute("DROP TABLE deeplore_evaluations")
    connection.execute("DROP TABLE deeplore_dataset_versions")
    connection.execute(
        "ALTER TABLE deeplore_dataset_versions_migrating RENAME TO deeplore_dataset_versions"
    )
    connection.execute(
        "ALTER TABLE deeplore_evaluations_migrating RENAME TO deeplore_evaluations"
    )
    connection.execute(
        f"CREATE INDEX {TIME_INDEX} ON deeplore_evaluations(run_id, evaluation_time)"
    )
    connection.execute(
        f"CREATE UNIQUE INDEX {IDENTITY_INDEX} "
        "ON deeplore_evaluations(run_id, dataset_name, dataset_version)"
    )


def migrate_evaluation_datasets(connection: sqlite3.Connection) -> dict[str, Any]:
    """Normalize dataset references atomically without changing evaluation values.

    Args:
        connection: SQLite connection without an active transaction.

    Returns:
        Whether storage changed, evaluation counts, and newly registered identities.

    Raises:
        ValueError: If source schema, identity evidence, or constraints are inconsistent.
        RuntimeError: If record contents or column metadata change unexpectedly.
        sqlite3.Error: If SQLite cannot complete the transactional rebuild.
    """
    if connection.in_transaction:
        raise ValueError(
            "Migration requires a connection without an active transaction"
        )
    foreign_keys_enabled = bool(connection.execute("PRAGMA foreign_keys").fetchone()[0])
    connection.execute("PRAGMA foreign_keys=OFF")
    try:
        connection.execute("BEGIN IMMEDIATE")
        _validate_dependencies(connection)
        columns = _read_columns(connection, EVALUATION_TABLE)
        migrated = "dataset_hash" not in {row[1] for row in columns}
        _validate_schema(connection, migrated)
        dataset_columns = _read_columns(connection, DATASET_TABLE)
        records = _read_visible_evaluations(connection, migrated)
        versions = _read_rows(
            connection, "SELECT * FROM deeplore_dataset_versions ORDER BY name, version"
        )
        versions_by_identity = {(row["name"], row["version"]): row for row in versions}
        _validate_records(records, versions_by_identity)
        additions = (
            []
            if migrated
            else _build_historical_versions(connection, records, versions_by_identity)
        )
        if not migrated:
            _migrate_tables(connection, records, [*versions, *additions])
            expected_columns = [
                (index, *column[1:])
                for index, column in enumerate(
                    column for column in columns if column[1] != "dataset_hash"
                )
            ]
            if _read_columns(connection, EVALUATION_TABLE) != expected_columns:
                raise RuntimeError("Evaluation column metadata changed unexpectedly")
            expected_dataset_columns = [
                (
                    *column[:3],
                    0 if column[1] in HISTORICAL_NULLABLE_COLUMNS else column[3],
                    *column[4:],
                )
                for column in dataset_columns
            ]
            if _read_columns(connection, DATASET_TABLE) != expected_dataset_columns:
                raise RuntimeError("Dataset column metadata changed unexpectedly")

        _validate_schema(connection, True)
        _validate_dependencies(connection)
        current = _read_visible_evaluations(connection, True)
        if current != records:
            raise RuntimeError(
                "Evaluation values or derived test hashes changed during migration"
            )
        actual_versions = _read_rows(
            connection, "SELECT * FROM deeplore_dataset_versions ORDER BY name, version"
        )
        expected_versions = sorted(
            [*versions, *additions], key=lambda row: (row["name"], row["version"])
        )
        if actual_versions != expected_versions:
            raise RuntimeError("Dataset version records changed unexpectedly")
        connection.commit()
        return {
            "changed": not migrated,
            "row_count": len(records),
            "confirmed_count": sum(
                row["association_status"] == "confirmed" for row in records
            ),
            "pending_count": sum(
                row["association_status"] == "pending" for row in records
            ),
            "registered_versions": [
                {"name": row["name"], "version": row["version"]} for row in additions
            ],
        }
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.execute(
            f"PRAGMA foreign_keys={'ON' if foreign_keys_enabled else 'OFF'}"
        )


# ===== Command entry =====


def main() -> None:
    """Migrate an existing SQLite database after backup and server shutdown."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    arguments = parser.parse_args()
    database = arguments.database.resolve(strict=True)
    with sqlite3.connect(database, timeout=30) as connection:
        result = migrate_evaluation_datasets(connection)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
