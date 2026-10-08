"""Rewrite ``base_run`` run tags from run names to run numbers.

A base run is referenced by its run_num, which never changes; tags written
earlier hold the base run's full name, whose leading field is that number.

Sections: tag conversion, transactional migration, command entry point.
Naming: build_* converts one value; migrate_* changes stored tags; main runs the command.
The caller must back up the database before applying this migration.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

# ===== Tag conversion =====

ENTRY_PATTERN = re.compile(r"r0*([1-9][0-9]*)(-.*)?")


def build_base_run(value: str) -> str | None:
    """Convert one ``base_run`` value to ``none`` or comma-separated run numbers.

    Args:
        value: ``none``, run numbers, or run names separated by commas.

    Returns:
        The converted value, or ``None`` when an entry has no leading run number.
    """
    entries = [entry.strip() for entry in value.split(",") if entry.strip()]
    if not entries or [entry.lower() for entry in entries] == ["none"]:
        return "none"
    numbers = []
    for entry in entries:
        match = ENTRY_PATTERN.fullmatch(entry)
        if match is None:
            return None
        numbers.append("r" + match.group(1))
    return ",".join(dict.fromkeys(numbers))


# ===== Transactional migration =====


def migrate_base_run_tags(database: Path, apply: bool) -> dict[str, Any]:
    """Convert every ``base_run`` tag, or only report what would change.

    Args:
        database: The tracking server's SQLite database.
        apply: Write the converted values; otherwise nothing is changed.

    Returns:
        Counts of converted and unchanged tags, and the tags left as they
        are because an entry has no leading run number.
    """
    connection = sqlite3.connect(database)
    try:
        rows = connection.execute(
            "SELECT run_uuid, value FROM tags WHERE key = 'base_run' ORDER BY run_uuid"
        ).fetchall()
        changes, skipped, unchanged = [], [], 0
        for run_uuid, value in rows:
            converted = build_base_run(value or "")
            if converted is None:
                skipped.append({"run_id": run_uuid, "value": value})
            elif converted == value:
                unchanged += 1
            else:
                changes.append((converted, run_uuid))
        if apply:
            with connection:
                connection.executemany(
                    "UPDATE tags SET value = ? WHERE key = 'base_run' AND run_uuid = ?", changes
                )
        return {
            "applied": apply,
            "converted": len(changes),
            "unchanged": unchanged,
            "skipped": skipped,
        }
    finally:
        connection.close()


# ===== Command entry point =====


def main() -> None:
    """Run the migration from the command line."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database", type=Path, required=True, help="Tracking SQLite database.")
    parser.add_argument("--apply", action="store_true", help="Write the converted tags.")
    args = parser.parse_args()
    if not args.database.is_file():
        raise SystemExit(f"database not found: {args.database}")
    print(json.dumps(migrate_base_run_tags(args.database, args.apply), indent=2))


if __name__ == "__main__":
    main()
