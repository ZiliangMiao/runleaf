"""Switch the NAS service to artifact-only mode with a database backup.

Sections:
    Filesystem helpers: Inherit parent permissions for migration records.
    Service checks: Validate artifact service health without creating runs.
    Migration entry point: Stop the old service, back up, and switch or roll back.

Naming:
    write_* persists migration records; validate_* checks service behavior.
"""

from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


# ===== Filesystem helpers =====

ROOT = Path("/volume1/AI/mlflow")
COMPOSE = ROOT / "compose" / "docker-compose.artifacts.yml"
BACKUP = ROOT / ".local" / "migrations" / "20261004T084518Z"
DOCKER = "/usr/local/bin/docker"


def inherit_permissions(path: Path) -> None:
    """Preserve the immediate parent's group and applicable permissions."""
    parent = path.parent.stat()
    os.chown(path, -1, parent.st_gid)
    path.chmod(parent.st_mode & (0o7777 if path.is_dir() else 0o666))


def write_record(path: Path, value: dict) -> None:
    """Persist a migration record with inherited permissions."""
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    inherit_permissions(path)


# ===== Service checks =====


def validate_service() -> None:
    """Require a healthy artifact server with disabled tracking endpoints."""
    error = None
    for attempt in range(30):
        try:
            with urlopen("http://192.168.110.26:5050/health", timeout=2) as response:
                assert response.read() == b"OK"
            with urlopen("http://192.168.110.26:5050/version", timeout=2) as response:
                assert response.read() == b"3.1.4"
            try:
                urlopen("http://192.168.110.26:5050/api/2.0/mlflow/experiments/get?experiment_id=4", timeout=2)
            except HTTPError as response:
                assert response.code == 503
                assert b"artifacts-only" in response.read()
            else:
                raise RuntimeError("Tracking endpoints are still enabled")
            with urlopen("http://192.168.110.26:5050/api/2.0/mlflow-artifacts/artifacts?path=4", timeout=2) as response:
                assert isinstance(json.load(response).get("files", []), list)
            return
        except (OSError, URLError, AssertionError, RuntimeError) as caught:
            error = caught
            time.sleep(1)
    raise RuntimeError("Artifact server failed its health checks") from error


# ===== Migration entry point =====


def main() -> None:
    """Perform the authorized NAS cutover or restart the original service."""
    if os.geteuid() != 0:
        raise SystemExit("Run this script with sudo on the NAS")
    os.umask(0)
    subprocess.run([DOCKER, "compose", "-f", str(COMPOSE), "config", "--quiet"], check=True)
    prior = subprocess.run([DOCKER, "inspect", "mlflow-server"], check=True, capture_output=True, text=True)
    container = json.loads(prior.stdout)[0]
    write_record(BACKUP / "container.before.json", {
        "image": container["Config"]["Image"],
        "command": container["Config"]["Cmd"],
        "mounts": container["Mounts"],
        "restart_policy": container["HostConfig"]["RestartPolicy"],
    })
    if not container["State"]["Running"] and (BACKUP / "cutover.json").is_file():
        validate_service()
        print("Artifact server is already active")
        return
    subprocess.run([DOCKER, "stop", "--time", "60", "mlflow-server"], check=True)
    try:
        database = BACKUP / "mlflow.cutover.db"
        source = sqlite3.connect((ROOT / "db" / "mlflow.db").as_uri() + "?mode=ro", uri=True)
        try:
            with sqlite3.connect(str(database)) as target:
                source.backup(target, pages=4096)
                assert target.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            source.close()
        inherit_permissions(database)
        digest = hashlib.sha256()
        with database.open("rb") as stream:
            for block in iter(lambda: stream.read(1048576), b""):
                digest.update(block)
        subprocess.run([DOCKER, "compose", "-f", str(COMPOSE), "up", "-d", "--pull", "never"], check=True)
        validate_service()
        shutil.copyfile(COMPOSE, ROOT / "compose" / "docker-compose.yml")
        inherit_permissions(ROOT / "compose" / "docker-compose.yml")
        write_record(BACKUP / "cutover.json", {
            "status": "artifact-server-active",
            "database": str(database),
            "sha256": digest.hexdigest(),
        })
    except BaseException:
        subprocess.run([DOCKER, "compose", "-f", str(COMPOSE), "stop"], check=False)
        subprocess.run([DOCKER, "start", "mlflow-server"], check=True)
        shutil.copyfile(BACKUP / "docker-compose.before.yml", ROOT / "compose" / "docker-compose.yml")
        inherit_permissions(ROOT / "compose" / "docker-compose.yml")
        raise
    print("NAS artifact server is active; the original container remains stopped for rollback")


if __name__ == "__main__":
    main()
