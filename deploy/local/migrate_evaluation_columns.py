"""Rename evaluation storage columns while the tracking server is stopped.

Sections: schema inspection, transactional migration, command entry point.
Naming: read_* inspects storage; migrate_* changes the schema; main runs the command.
The caller must back up the database before invoking this offline migration.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any


# ===== Schema inspection =====

COLUMN_RENAMES = {
    "evaluated_at": "evaluation_time",
    "test_hash": "dataset_hash",
    "ckpt_path": "checkpoint_path",
    "ckpt_hash": "checkpoint_hash",
    "params_json": "params",
    "metrics_json": "metrics",
}


def _read_indexes(connection: sqlite3.Connection) -> dict[str, Any]:
    indexes = {}
    for row in connection.execute("PRAGMA index_list(deeplore_evaluations)"):
        indexes[row[1]] = {
            "properties": tuple(row[2:]),
            "columns": [
                column[2]
                for column in connection.execute(
                    "SELECT * FROM pragma_index_info(?) ORDER BY seqno", (row[1],)
                )
            ],
        }
    return indexes


# ===== Transactional migration =====


def migrate_evaluation_columns(connection: sqlite3.Connection) -> dict[str, Any]:
    """Rename six columns atomically without changing stored values or constraints.

    Args:
        connection: SQLite connection with no active transaction and tuple rows.

    Returns:
        Whether the schema changed, the row count, and final column names.

    Raises:
        ValueError: If a transaction is active or the source schema is ambiguous.
        RuntimeError: If data, indexes, column types, or foreign keys change.
        sqlite3.Error: If SQLite cannot complete the schema changes.
    """
    if connection.in_transaction:
        raise ValueError(
            "Migration requires a connection without an active transaction"
        )
    connection.execute("BEGIN IMMEDIATE")
    try:
        columns = connection.execute(
            "PRAGMA table_info(deeplore_evaluations)"
        ).fetchall()
        names = {column[1] for column in columns}
        old_names = set(COLUMN_RENAMES)
        new_names = set(COLUMN_RENAMES.values())
        already_migrated = new_names <= names and not old_names & names
        if not already_migrated and not (old_names <= names and not new_names & names):
            raise ValueError(
                "Expected either all original or all renamed evaluation columns"
            )

        records = connection.execute(
            "SELECT * FROM deeplore_evaluations ORDER BY evaluation_id"
        ).fetchall()
        if already_migrated:
            connection.commit()
            return {
                "changed": False,
                "row_count": len(records),
                "columns": [row[1] for row in columns],
            }

        indexes = _read_indexes(connection)
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        foreign_key_definitions = connection.execute(
            "PRAGMA foreign_key_list(deeplore_evaluations)"
        ).fetchall()
        for old_name, new_name in COLUMN_RENAMES.items():
            connection.execute(
                f'ALTER TABLE deeplore_evaluations RENAME COLUMN "{old_name}" TO "{new_name}"'
            )

        expected_columns = [
            (row[0], COLUMN_RENAMES.get(row[1], row[1]), *row[2:]) for row in columns
        ]
        for index in indexes.values():
            index["columns"] = [
                COLUMN_RENAMES.get(name, name) for name in index["columns"]
            ]
        if (
            connection.execute("PRAGMA table_info(deeplore_evaluations)").fetchall()
            != expected_columns
        ):
            raise RuntimeError("Evaluation column metadata changed unexpectedly")
        if (
            connection.execute(
                "SELECT * FROM deeplore_evaluations ORDER BY evaluation_id"
            ).fetchall()
            != records
        ):
            raise RuntimeError("Evaluation records changed during the column migration")
        if _read_indexes(connection) != indexes:
            raise RuntimeError("Evaluation indexes changed unexpectedly")
        if (
            connection.execute(
                "PRAGMA foreign_key_list(deeplore_evaluations)"
            ).fetchall()
            != foreign_key_definitions
        ):
            raise RuntimeError(
                "Evaluation foreign key definitions changed unexpectedly"
            )
        if connection.execute("PRAGMA foreign_key_check").fetchall() != foreign_keys:
            raise RuntimeError(
                "Foreign key integrity changed during the column migration"
            )
        connection.commit()
        return {
            "changed": True,
            "row_count": len(records),
            "columns": [row[1] for row in expected_columns],
        }
    except BaseException:
        connection.rollback()
        raise


# ===== Command entry point =====


def main() -> None:
    """Migrate an existing SQLite database after backup and server shutdown."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    arguments = parser.parse_args()
    database = arguments.database.resolve(strict=True)
    with sqlite3.connect(database, timeout=30) as connection:
        result = migrate_evaluation_columns(connection)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
