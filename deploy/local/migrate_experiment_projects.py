"""Assign existing experiments to registered projects.

Projects used to be the first hyphen-separated field of an experiment name; now
they are registered rows in ``deeplore_projects`` and an experiment belongs to
one through its ``project`` tag. This one-off migration registers the projects
in use and tags their experiments, deleted ones included, so the server's run
numbering keeps covering every run they hold.

A project is in use when it owns a run-number sequence or names an active
experiment. Experiments outside those projects stay unassigned and are
reported; an existing ``project`` tag is kept, and reported when it disagrees
with the name.

Sections: name parsing, transactional migration, command entry point.
Naming: build_* derives one value; migrate_* changes stored rows; main runs the command.
The caller must back up the database before applying this migration.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

# ===== Name parsing =====

PROJECT_TAG = "project"
# Same rule as mlflow.deeplore.project_api.PROJECT_PATTERN.
PROJECT_PATTERN = re.compile(r"[a-z0-9_]+")
# Same schema as mlflow.deeplore.project_api.SqlProject.
PROJECTS_TABLE = """
CREATE TABLE IF NOT EXISTS deeplore_projects (
    name VARCHAR(256) NOT NULL,
    description TEXT,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (name)
)
"""


def build_legacy_project(experiment_name: str) -> Optional[str]:
    """Return the project an experiment name implied, or None if it implied none.

    Args:
        experiment_name: Name formerly read as ``<project>-<suffix>``.

    Returns:
        The field before the first hyphen when the suffix is nonempty and the
        field is a valid project name, else None.
    """
    project, separator, suffix = experiment_name.partition("-")
    if separator and suffix.strip() and PROJECT_PATTERN.fullmatch(project):
        return project
    return None


# ===== Transactional migration =====


def _has_table(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def migrate_experiment_projects(database: Path, apply: bool) -> dict[str, Any]:
    """Register the projects in use and tag their experiments, or only report the plan.

    Args:
        database: The tracking server's SQLite database.
        apply: Write the projects and tags; otherwise nothing is changed.

    Returns:
        The projects registered, the experiments tagged, kept, in conflict and
        left unassigned.
    """
    connection = sqlite3.connect(database)
    try:
        experiments = connection.execute(
            "SELECT experiment_id, name, lifecycle_stage FROM experiments ORDER BY experiment_id"
        ).fetchall()
        tags = dict(
            connection.execute(
                "SELECT experiment_id, value FROM experiment_tags WHERE key = ?", (PROJECT_TAG,)
            ).fetchall()
        )
        registered = (
            {row[0] for row in connection.execute("SELECT name FROM deeplore_projects")}
            if _has_table(connection, "deeplore_projects")
            else set()
        )
        sequences = (
            {row[0] for row in connection.execute("SELECT project FROM deeplore_run_numbers")}
            if _has_table(connection, "deeplore_run_numbers")
            else set()
        )
        in_use = {name for name in sequences if PROJECT_PATTERN.fullmatch(name)} | {
            project
            for _, name, stage in experiments
            if stage == "active" and (project := build_legacy_project(name))
        }

        tagged, kept, conflicts, unassigned = [], [], [], []
        for experiment_id, name, stage in experiments:
            entry = {"experiment_id": str(experiment_id), "name": name, "lifecycle_stage": stage}
            legacy = build_legacy_project(name)
            if experiment_id in tags:
                kept.append({**entry, "project": tags[experiment_id]})
                if PROJECT_PATTERN.fullmatch(tags[experiment_id] or ""):
                    in_use.add(tags[experiment_id])
                if legacy and legacy != tags[experiment_id]:
                    conflicts.append(
                        {**entry, "project": tags[experiment_id], "name_project": legacy}
                    )
            elif legacy in in_use:
                tagged.append({**entry, "project": legacy})
            else:
                unassigned.append(entry)
        new_projects = sorted(in_use - registered)

        if apply:
            created_at = int(time.time() * 1000)
            with connection:
                connection.execute(PROJECTS_TABLE)
                connection.executemany(
                    "INSERT INTO deeplore_projects (name, description, created_at) "
                    "VALUES (?, NULL, ?)",
                    [(name, created_at) for name in new_projects],
                )
                connection.executemany(
                    "INSERT INTO experiment_tags (key, value, experiment_id) VALUES (?, ?, ?)",
                    [(PROJECT_TAG, item["project"], int(item["experiment_id"])) for item in tagged],
                )
        return {
            "applied": apply,
            "projects_registered": new_projects,
            "experiments_tagged": tagged,
            "experiments_kept": kept,
            "conflicts": conflicts,
            "experiments_unassigned": unassigned,
        }
    finally:
        connection.close()


# ===== Command entry point =====


def main() -> None:
    """Run the migration from the command line."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database", type=Path, required=True, help="Tracking SQLite database.")
    parser.add_argument("--apply", action="store_true", help="Write the projects and tags.")
    args = parser.parse_args()
    if not args.database.is_file():
        raise SystemExit(f"database not found: {args.database}")
    print(json.dumps(migrate_experiment_projects(args.database, args.apply), indent=2))


if __name__ == "__main__":
    main()
