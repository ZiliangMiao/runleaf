"""Deploy the verified MLflow bar-label patch and persist its bind mount.

Sections: constants, shared commands, deployment entry point.
Naming: run_* executes commands; main performs the deployment.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path


# ===== Constants =====
DOCKER = ["sudo", "-n", "/usr/local/bin/docker"]
CONTAINER = "mlflow-server"
NAME = "9857.0cda3ddd.chunk.js"
ORIGINAL_SHA256 = "9c0080b197df11819b8513a864008a449e13377b66a05bb4ecb49bffdca3af29"
PATCHED_SHA256 = "754226251632c537d6c911433f241e348346b7615cbbc394558adc4374937937"
OLD = 'function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:2;return"number"===typeof e?e.toFixed(t):e}'
NEW = OLD.replace("arguments[1]:2;", "arguments[1]:3;")
DIRECTORY = Path("/volume1/AI/mlflow/compose")


# ===== Shared commands =====
def run_command(arguments: list[str], data: bytes | None = None) -> bytes:
    """Run a checked command and return its standard output."""
    return subprocess.run(arguments, input=data, stdout=subprocess.PIPE, check=True).stdout


# ===== Deployment entry point =====
def main() -> None:
    """Patch only the verified asset and preserve its original for rollback."""
    target = Path(run_command(DOCKER + [
        "exec", CONTAINER, "python3", "-B", "-c",
        "import importlib.util; from pathlib import Path; "
        "print(Path(importlib.util.find_spec('mlflow').origin).parent / 'server' / 'js' / 'build' / 'static' / 'js' / '9857.0cda3ddd.chunk.js')",
    ]).decode().strip())
    original = run_command(DOCKER + ["exec", CONTAINER, "cat", str(target)])
    digest = hashlib.sha256(original).hexdigest()
    if digest != ORIGINAL_SHA256:
        raise RuntimeError("Unexpected asset hash; refusing to modify this deployment: " + digest)
    source = original.decode()
    if source.count(OLD) != 1:
        raise RuntimeError("Expected exactly one bar-label formatter")
    patched = source.replace(OLD, NEW).encode()
    if hashlib.sha256(patched).hexdigest() != PATCHED_SHA256:
        raise RuntimeError("Patched asset failed verification")

    compose = DIRECTORY / "docker-compose.yml"
    configuration = compose.read_text()
    anchor = "      - /volume1/AI/mlflow/deepdet-yolox:/mlflow/artifacts\n"
    if configuration.count(anchor) != 1:
        raise RuntimeError("Unexpected compose configuration; refusing to edit")
    assets = DIRECTORY / "ui-three-decimals"
    if assets.exists():
        raise RuntimeError("Deployment backup already exists; inspect before retrying")

    # These are permanent deployment assets and rollback copies, not scratch files.
    assets.mkdir()
    (assets / "docker-compose.original.yml").write_text(configuration)
    (assets / (NAME + ".original")).write_bytes(original)
    replacement = assets / NAME
    replacement.write_bytes(patched)
    mount = "      - " + str(replacement) + ":" + str(target) + ":ro\n"
    updated = configuration.replace(anchor, anchor + mount)
    compose.write_text(updated)
    try:
        run_command(DOCKER + ["compose", "-f", str(compose), "config", "--quiet"])
        # Update the running asset without restarting tracking workers.
        run_command(DOCKER + [
            "exec", "-i", "--user", "0", CONTAINER, "python3", "-B", "-c",
            "import sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())",
            str(target),
        ], patched)
        actual = run_command(DOCKER + ["exec", CONTAINER, "cat", str(target)])
        if actual != patched:
            raise RuntimeError("Deployed asset failed byte verification")
    except BaseException:
        compose.write_text(configuration)
        run_command(DOCKER + [
            "exec", "-i", "--user", "0", CONTAINER, "python3", "-B", "-c",
            "import sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())",
            str(target),
        ], original)
        raise
    print("Bar labels now use three decimal places; compose bind mount preserves the patch after recreation.")
    print("Rollback copies: " + str(assets))


if __name__ == "__main__":
    main()
