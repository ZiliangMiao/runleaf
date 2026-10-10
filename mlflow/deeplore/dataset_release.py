"""Release one version of a Deeplore dataset: check, dvc add, commit, tag, push, register.

A dataset lives in a git + DVC repository under ``<repo>/data/<name>/``::

    metadata.yaml                        release metadata, written only by this module
    assets/            assets.dvc        raw data; may be empty
    annotations/       annotations.dvc   optional
    samples/<split>/   samples/<split>.dvc   optional; split is train, val or test
        data.json | shard_000000.json ...    generated samples
        _reference.json                      md5 of every outside file the samples read

The whole dataset shares ONE version. Every split keeps its own directory hash
and no hash of ``samples/`` as a whole exists, so a change to a file that a
split does not read never changes that split's identity.

Samples reference outside files by dataset-root-relative POSIX paths: any JSON
string in a sample file that starts with ``assets/`` or ``annotations/`` is a
dependency that the split's ``_reference.json`` must list.

A release runs steps 2-8 (step 1 is the caller supplying ``version``,
``change`` and the units to delete):

    2 check      nothing is modified
    3 dvc add    one unit per existing directory; a deleted unit loses its pointer
    4 metadata   version, changelog entry and split hashes into metadata.yaml
    5 git add    only metadata.yaml, .dvc pointers and DVC's .gitignore files
    6 commit     those paths as ``dataset(<name>): release <version>, <change>``, plus a tag
    7 push       ``dvc push`` first, then an atomic ``git push`` of branch and tag
    8 register   metadata read back from the tag's commit goes to MLflow

Uncommitted changes may sit only under ``data/``. Another dataset's changes,
staged or not, stay out of the commit and wait for that dataset's own release.

A unit (``assets``, ``annotations`` or a split) is deleted only when the
caller lists it: a directory that is merely absent, e.g. in a clone that never
ran ``dvc pull``, fails the check instead of dropping its pointer.

A failure in steps 3-6 rolls everything back: the tag, the commit,
``metadata.yaml``, the pointers and DVC's ``.gitignore`` files. A failure in
steps 7-8 leaves the local commit and tag in place; releasing the same version
again resumes at step 7.

Sections:
- Layout: paths of a dataset's release units.
- Metadata: ``metadata.yaml`` and ``.dvc`` pointer IO.
- Version: format and succession rules.
- Samples: sample files, ``_reference.json``, dependency discovery and hashes.
- Commands: git and dvc subprocesses.
- Checks: step 2.
- Release: steps 3-8.
- Archive: remove or restore a whole dataset directory.
- CLI.

Verb paradigm:

| verb | role |
|---|---|
| ``find_*`` | discover paths or values on disk |
| ``read_*`` / ``write_*`` | load / persist one file |
| ``parse_*`` / ``build_*`` | pure conversion / construction in memory |
| ``run_*`` | execute a subprocess |
| ``check_*`` | validate and return findings, never modify |
| ``release_*`` | modify the repository |
"""

import argparse
import fcntl
import getpass
import hashlib
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Collection, Iterator, Optional, Sequence

import yaml

# ===== Layout: paths of a dataset's release units =====

DATA_DIR = "data"
METADATA_FILE = "metadata.yaml"
ASSETS_DIR = "assets"
ANNOTATIONS_DIR = "annotations"
SAMPLES_DIR = "samples"
SPLITS: tuple[str, ...] = ("train", "val", "test")
UNITS: tuple[str, ...] = (ASSETS_DIR, ANNOTATIONS_DIR, *SPLITS)
NAME_PATTERN = re.compile(r"^[a-z][a-z0-9-]*$")
SAMPLE_FILE = "data.json"
SHARD_PATTERN = re.compile(r"^shard_(\d+)\.json$")
REFERENCE_FILE = "_reference.json"
REFERENCE_HASH = "md5"
DEPENDENCY_PREFIXES: tuple[str, ...] = (f"{ASSETS_DIR}/", f"{ANNOTATIONS_DIR}/")


@dataclass(frozen=True)
class Dataset:
    """One dataset inside its repository: every path a release touches.

    Binds a repository to a dataset name so each step derives identical paths.
    It owns path arithmetic only; it reads no file and holds no git state.

    Attributes:
        repo: Root of the git + DVC repository.
        name: Dataset name, the directory name under ``data/``.
    """

    repo: Path
    name: str

    @property
    def root(self) -> Path:
        """The dataset directory ``<repo>/data/<name>``."""
        return self.repo / DATA_DIR / self.name

    @property
    def metadata_path(self) -> Path:
        """The dataset's ``metadata.yaml``."""
        return self.root / METADATA_FILE

    def split_dir(self, split: str) -> Path:
        """One split's samples directory."""
        return self.root / SAMPLES_DIR / split

    def unit_dir(self, unit: str) -> Path:
        """One release unit's directory: assets, annotations or a split."""
        return self.split_dir(unit) if unit in SPLITS else self.root / unit

    @property
    def unit_dirs(self) -> list[Path]:
        """Every directory the layout tracks with DVC, existing or not."""
        return [self.unit_dir(unit) for unit in UNITS]

    def tag(self, version: str) -> str:
        """The git tag of one released version (``<name>-<version>``)."""
        return f"{self.name}-{version}"

    def relative(self, path: Path) -> str:
        """A path inside the repository as a repo-relative POSIX string."""
        return path.relative_to(self.repo).as_posix()


def pointer_path(unit_dir: Path) -> Path:
    """Return the ``.dvc`` pointer that tracks a unit directory."""
    return unit_dir.with_name(unit_dir.name + ".dvc")


def _find_release_files(dataset: Dataset) -> list[Path]:
    """Every file a release may write: metadata, pointers and DVC's .gitignore files."""
    return [
        dataset.metadata_path,
        *(pointer_path(unit_dir) for unit_dir in dataset.unit_dirs),
        dataset.root / ".gitignore",
        dataset.root / SAMPLES_DIR / ".gitignore",
    ]


def find_datasets(repo: Path) -> list[Dataset]:
    """List the datasets of a repository, i.e. ``data/*/metadata.yaml``.

    Args:
        repo: Root of the git + DVC repository.

    Returns:
        Datasets sorted by name.
    """
    return [
        Dataset(repo, path.parent.name)
        for path in sorted((repo / DATA_DIR).glob(f"*/{METADATA_FILE}"))
    ]


# ===== Metadata: metadata.yaml and .dvc pointer IO =====


class ReleaseError(Exception):
    """A release cannot proceed; the message is meant for the person releasing.

    Attributes:
        findings: Check results behind the failure, empty for a step failure.
    """

    def __init__(self, message: str, findings: Optional[list["Finding"]] = None) -> None:
        super().__init__(message)
        self.findings = findings or []


class _MetadataDumper(yaml.SafeDumper):
    """YAML dumper that indents block sequences under their key.

    Exists only because PyYAML exposes indentation through subclassing. It
    owns formatting, never content.
    """

    def increase_indent(self, flow: bool = False, indentless: bool = False) -> None:
        """Indent sequences instead of aligning them with their parent key."""
        return super().increase_indent(flow, False)


class _FlowList(list):
    """A list emitted inline (``[a, b]``); marks ``metrics`` for the dumper."""


_MetadataDumper.add_representer(
    _FlowList,
    lambda dumper, data: dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=True),
)


# ``root`` was an absolute path; the directory follows from the repo and ``name``.
RETIRED_FIELDS: frozenset[str] = frozenset({"primary_metric", "taxonomy", "root"})


def build_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Return dataset metadata without retired descriptive fields.

    Args:
        metadata: Current or historical dataset metadata.

    Returns:
        A new mapping preserving supported fields and historical change text.
    """
    return {key: value for key, value in metadata.items() if key not in RETIRED_FIELDS}


def build_metadata_template(name: str, source: str, metrics: list[str]) -> dict[str, Any]:
    """Return the ``metadata.yaml`` content of a dataset that was never released.

    Args:
        name: Dataset name, the directory under ``data/``.
        source: Where the data comes from.
        metrics: Metric names every evaluation on this dataset must record.

    Returns:
        Metadata with a null version, null split hashes and an empty changelog.
    """
    return {
        "name": name,
        "source": source,
        "version": None,
        "hashes": dict.fromkeys(SPLITS),
        "metrics": list(metrics),
        "changelog": [],
    }


def parse_metadata(text: str, source: str) -> dict:
    """Parse ``metadata.yaml`` content.

    Args:
        text: Raw YAML.
        source: Where the text came from, for error messages.

    Returns:
        The metadata mapping, keys in file order.

    Raises:
        ReleaseError: If the text is not a YAML mapping.
    """
    try:
        metadata = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise ReleaseError(f"{source} is not valid YAML: {error}") from error
    if not isinstance(metadata, dict):
        raise ReleaseError(f"{source} must be a YAML mapping")
    return build_metadata(metadata)


def read_metadata(path: Path) -> dict:
    """Read a dataset's ``metadata.yaml``.

    Args:
        path: The ``metadata.yaml`` path.

    Returns:
        The metadata mapping, keys in file order.

    Raises:
        ReleaseError: If the file is missing or not a YAML mapping.
    """
    if not path.is_file():
        raise ReleaseError(f"{path} does not exist")
    return parse_metadata(path.read_text(encoding="utf-8"), str(path))


def write_metadata(path: Path, metadata: dict) -> None:
    """Write ``metadata.yaml`` with stable formatting.

    Args:
        path: The ``metadata.yaml`` path.
        metadata: The metadata mapping; key order is preserved.
    """
    document = build_metadata(metadata)
    if isinstance(document.get("metrics"), list):
        document["metrics"] = _FlowList(document["metrics"])
    path.write_text(
        yaml.dump(
            document,
            Dumper=_MetadataDumper,
            sort_keys=False,
            allow_unicode=True,
            default_flow_style=False,
            width=float("inf"),
        ),
        encoding="utf-8",
    )


def parse_changelog_versions(metadata: dict) -> list[str]:
    """List the versions recorded in a metadata mapping's ``changelog``."""
    return [
        str(version)
        for entry in metadata.get("changelog") or []
        if isinstance(entry, dict)
        for version in entry
    ]


def read_pointer_md5(pointer: Path) -> str:
    """Read ``outs[0].md5`` from a ``.dvc`` pointer, ``.dir`` suffix included.

    Args:
        pointer: The ``.dvc`` file of a tracked directory.

    Returns:
        The directory hash, e.g. ``0f9d...bf.dir``.

    Raises:
        ReleaseError: If the pointer lacks ``outs[0].md5``.
    """
    document = yaml.safe_load(pointer.read_text(encoding="utf-8"))
    outs = document.get("outs") if isinstance(document, dict) else None
    md5 = (
        outs[0].get("md5")
        if isinstance(outs, list) and outs and isinstance(outs[0], dict)
        else None
    )
    if not md5:
        raise ReleaseError(f"{pointer} has no outs[0].md5")
    return str(md5)


def build_released_metadata(
    metadata: dict,
    version: str,
    change: str,
    hashes: dict[str, Optional[str]],
) -> dict:
    """Return metadata updated for a release, omitting retired fields.

    Args:
        metadata: The current metadata mapping.
        version: The version being released.
        change: One-line description of what changed.
        hashes: Split name -> its directory hash, or ``None`` for an absent split.

    Returns:
        A new mapping with ``version``, ``hashes`` and an appended ``changelog`` entry.
    """
    return {
        **build_metadata(metadata),
        "version": version,
        "hashes": {split: hashes.get(split) for split in SPLITS},
        "changelog": [*(metadata.get("changelog") or []), {version: change}],
    }


def parse_hashes(metadata: dict) -> dict[str, Optional[str]]:
    """Read a metadata mapping's ``hashes`` as split -> hash.

    Accepts the mapping form and the list of single-split mappings that
    metadata written before the mapping form carries.
    """
    hashes: dict[str, Optional[str]] = dict.fromkeys(SPLITS)
    recorded = metadata.get("hashes") or {}
    for entry in [recorded] if isinstance(recorded, dict) else recorded:
        if isinstance(entry, dict):
            hashes.update({str(split): value for split, value in entry.items()})
    return hashes


# ===== Version: format and succession rules =====

VERSION_PATTERN = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
FIRST_VERSION = "v1.0.0"


def parse_version(version: str) -> tuple[int, int, int]:
    """Parse ``vMAJOR.MINOR.PATCH`` into integers.

    Args:
        version: A version string such as ``v1.2.0``.

    Returns:
        ``(major, minor, patch)``.

    Raises:
        ValueError: If the string is not ``v`` plus three dot-separated numbers
            without leading zeros.
    """
    match = VERSION_PATTERN.match(version)
    if match is None:
        raise ValueError(f"version {version!r} is not vMAJOR.MINOR.PATCH")
    major, minor, patch = (int(part) for part in match.groups())
    return major, minor, patch


def parse_changelog(changelog: Any) -> dict[str, str]:
    """Validate historical version changes and flatten them into a mapping.

    Args:
        changelog: A list of single-version mappings, or ``None``.

    Returns:
        Version strings mapped to their original change text.

    Raises:
        ValueError: If the structure, version, text or duplicate entry is invalid.
    """
    if changelog is None:
        return {}
    if not isinstance(changelog, list):
        raise ValueError("changelog must be a list of single-version mappings")
    changes: dict[str, str] = {}
    for entry in changelog:
        if not isinstance(entry, dict) or len(entry) != 1:
            raise ValueError("each changelog entry must contain exactly one version")
        version, change = next(iter(entry.items()))
        if not isinstance(version, str):
            raise ValueError("changelog versions must be strings")
        parse_version(version)
        if not isinstance(change, str) or not change.strip():
            raise ValueError(f"{version} changelog must contain non-empty text")
        if version in changes and changes[version] != change:
            raise ValueError(f"{version} has conflicting changelog entries")
        changes[version] = change
    return changes


def build_next_versions(current: Optional[str]) -> list[str]:
    """List the versions that may follow ``current`` without skipping a number.

    Args:
        current: The latest released version, or ``None`` before the first release.

    Returns:
        The patch, minor and major successors, in that order; only ``v1.0.0``
        before the first release.
    """
    if not current:
        return [FIRST_VERSION]
    major, minor, patch = parse_version(current)
    return [f"v{major}.{minor}.{patch + 1}", f"v{major}.{minor + 1}.0", f"v{major + 1}.0.0"]


# ===== Samples: sample files, _reference.json and dependency discovery =====


def find_sample_files(split_dir: Path) -> list[Path]:
    """List a split's sample files: ``data.json`` or a full run of shards.

    Args:
        split_dir: One split's samples directory.

    Returns:
        ``[data.json]`` or the shards in index order.

    Raises:
        ReleaseError: If there is no sample file, both forms coexist, or the
            shards are not zero-padded to one width and contiguous from 0.
    """
    single = split_dir / SAMPLE_FILE
    shards = sorted(
        (path for path in split_dir.iterdir() if SHARD_PATTERN.match(path.name)),
        key=lambda path: int(SHARD_PATTERN.match(path.name).group(1)),
    )
    if single.is_file() and shards:
        raise ReleaseError(f"{split_dir} holds both {SAMPLE_FILE} and shard files")
    if single.is_file():
        return [single]
    if not shards:
        raise ReleaseError(f"{split_dir} has neither {SAMPLE_FILE} nor shard_*.json")

    digits = {len(SHARD_PATTERN.match(path.name).group(1)) for path in shards}
    indices = [int(SHARD_PATTERN.match(path.name).group(1)) for path in shards]
    if len(digits) != 1 or indices != list(range(len(shards))):
        raise ReleaseError(
            f"{split_dir} shards must share one zero-padded width and run from 0 without gaps"
        )
    return shards


def read_reference(split_dir: Path) -> dict[str, str]:
    """Read a split's ``_reference.json`` and return its path -> md5 map.

    Args:
        split_dir: One split's samples directory.

    Returns:
        Dataset-root-relative POSIX path -> hex md5.

    Raises:
        ReleaseError: If the file is missing or does not follow the format
            ``{"hash": "md5", "files": {<path>: <md5>}}``.
    """
    reference_path = split_dir / REFERENCE_FILE
    if not reference_path.is_file():
        raise ReleaseError(f"{reference_path} does not exist; rerun the build script")
    try:
        reference = json.loads(reference_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ReleaseError(f"{reference_path} is not valid JSON: {error}") from error
    files = reference.get("files") if isinstance(reference, dict) else None
    if (
        not isinstance(reference, dict)
        or reference.get("hash") != REFERENCE_HASH
        or not isinstance(files, dict)
    ):
        raise ReleaseError(
            f'{reference_path} must be {{"hash": "{REFERENCE_HASH}", "files": {{...}}}}'
        )
    malformed = [
        path
        for path, digest in files.items()
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{32}", digest)
    ]
    if malformed:
        raise ReleaseError(f"{reference_path} has non-md5 digests, e.g. {malformed[:3]}")
    return files


def _collect_dependencies(node: Any, found: set[str]) -> None:
    """Add every dependency-prefixed string below ``node`` to ``found``."""
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            if current.startswith(DEPENDENCY_PREFIXES):
                found.add(current)
        elif isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def find_dependencies(sample_files: list[Path]) -> set[str]:
    """Collect the outside files a split's samples read.

    A dependency is any JSON string value that starts with ``assets/`` or
    ``annotations/``. The whole file is parsed, which for a large split costs
    several times its size in memory.

    Args:
        sample_files: The split's sample files.

    Returns:
        Dataset-root-relative POSIX paths.

    Raises:
        ReleaseError: If a sample file is not valid JSON.
    """
    found: set[str] = set()
    for sample_file in sample_files:
        try:
            with sample_file.open("r", encoding="utf-8") as handle:
                _collect_dependencies(json.load(handle), found)
        except json.JSONDecodeError as error:
            raise ReleaseError(f"{sample_file} is not valid JSON: {error}") from error
    return found


def build_md5(path: Path) -> str:
    """Return the hex md5 of one file's bytes."""
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_dir_md5(directory: Path) -> str:
    """Return a directory's hash as DVC 3 records it in ``outs[0].md5``.

    Every file below the directory becomes ``{"md5", "relpath"}``; the list
    sorted by ``relpath`` is dumped with ``json.dumps(..., sort_keys=True)``
    and hashed. Verifiers use the same definition without installing DVC.

    Args:
        directory: A split's samples directory.

    Returns:
        The hex md5 of the listing plus the ``.dir`` suffix.
    """
    entries = sorted(
        (
            {"md5": build_md5(path), "relpath": path.relative_to(directory).as_posix()}
            for path in directory.rglob("*")
            if path.is_file()
        ),
        key=lambda entry: entry["relpath"],
    )
    listing = json.dumps(entries, sort_keys=True).encode("utf-8")
    return hashlib.md5(listing, usedforsecurity=False).hexdigest() + ".dir"


# ===== Commands: git and dvc subprocesses =====

Log = Callable[[str], None]


def run_command(args: list[str], cwd: Path, log: Log) -> str:
    """Run one command to completion and return its standard output.

    Args:
        args: Program and arguments.
        cwd: Working directory.
        log: Receives the command line, standard output and standard error.

    Returns:
        Standard output, stripped. Standard error is logged separately.

    Raises:
        ReleaseError: If the program is missing or exits non-zero.
    """
    log("$ " + " ".join(args))
    # Output is captured, so a credential prompt would hang unseen.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    try:
        completed = subprocess.run(
            args,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except FileNotFoundError as error:
        raise ReleaseError(f"{args[0]} is not installed in the release environment") from error
    output = completed.stdout.strip()
    diagnostics = completed.stderr.strip()
    for text in (output, diagnostics):
        if text:
            log(text)
    if completed.returncode != 0:
        details = "\n".join(text for text in (output, diagnostics) if text)
        raise ReleaseError(
            f"`{' '.join(args)}` failed with exit code {completed.returncode}:\n{details}"
        )
    return output


def run_git(repo: Path, *args: str, log: Log) -> str:
    """Run a git command inside the repository."""
    return run_command(["git", *args], repo, log)


def run_dvc(repo: Path, *args: str, log: Log) -> str:
    """Run a dvc command inside the repository."""
    return run_command(["dvc", *args], repo, log)


def _succeeds(repo: Path, *args: str) -> bool:
    """Whether a git query exits zero; its output is discarded."""
    try:
        run_git(repo, *args, log=lambda line: None)
    except ReleaseError:
        return False
    return True


# ===== Checks: step 2, nothing is modified =====

LEVEL_ERROR = "error"
LEVEL_WARNING = "warning"


@dataclass(frozen=True)
class Finding:
    """One result of the pre-release checks.

    Attributes:
        level: ``error`` blocks the release; ``warning`` is shown and passed over.
        check: The check that produced it: version, git, layout, samples, reference
            or overlap.
        message: What is wrong and, where possible, how to fix it.
    """

    level: str
    check: str
    message: str


def _is_unreleased_metadata(metadata: dict[str, Any]) -> bool:
    hashes = metadata.get("hashes")
    return (
        metadata.get("version") is None
        and not metadata.get("changelog")
        and isinstance(hashes, dict)
        and all(value is None for value in hashes.values())
    )


def _find_renamed_release_paths(dataset: Dataset, log: Log) -> set[str]:
    """Find control-file deletions of one unambiguous, unpublished dataset rename."""
    head_paths = set(
        run_git(
            dataset.repo, "ls-tree", "-r", "--name-only", "HEAD", "--", DATA_DIR, log=log
        ).splitlines()
    )
    if dataset.relative(dataset.metadata_path) in head_paths:
        return set()

    # Metrics may be edited with the rename; published identity must remain empty.
    new_datasets: list[tuple[Dataset, dict[str, Any]]] = []
    for candidate in find_datasets(dataset.repo):
        if candidate.relative(candidate.metadata_path) in head_paths or candidate.root.is_symlink():
            continue
        try:
            metadata = read_metadata(candidate.metadata_path)
        except (OSError, ReleaseError):
            continue
        if metadata.get("name") == candidate.name and _is_unreleased_metadata(metadata):
            identity = {
                key: value for key, value in metadata.items() if key not in {"name", "metrics"}
            }
            new_datasets.append((candidate, identity))
    if not any(candidate == dataset for candidate, _ in new_datasets):
        return set()

    matches: list[set[str]] = []
    for relative in sorted(head_paths):
        path = PurePosixPath(relative)
        if path.name != METADATA_FILE or path.parent.parent != PurePosixPath(DATA_DIR):
            continue
        previous = Dataset(dataset.repo, path.parent.name)
        if previous.root.exists() or previous.root.is_symlink():
            continue
        old_paths = {name for name in head_paths if path.parent in PurePosixPath(name).parents}
        allowed = {previous.relative(file) for file in _find_release_files(previous)}
        if not old_paths <= allowed:
            continue
        try:
            metadata = parse_metadata(
                run_git(dataset.repo, "show", f"HEAD:{relative}", log=log), relative
            )
        except ReleaseError:
            continue
        if metadata.get("name") != previous.name or not _is_unreleased_metadata(metadata):
            continue
        identity = {
            key: value for key, value in metadata.items() if key not in {"name", "metrics"}
        }
        matching_datasets: list[Dataset] = []
        for candidate, candidate_identity in new_datasets:
            if candidate_identity != identity:
                continue
            for old_path in sorted(old_paths):
                if PurePosixPath(old_path).name != ".gitignore":
                    continue
                replacement = candidate.root / PurePosixPath(old_path).relative_to(path.parent)
                if not replacement.is_file() or run_git(
                    dataset.repo, "hash-object", "--", candidate.relative(replacement), log=log
                ) != run_git(dataset.repo, "rev-parse", f"HEAD:{old_path}", log=log):
                    break
            else:
                matching_datasets.append(candidate)
        # A deleted dataset must not be claimed by two newly created datasets.
        if dataset in matching_datasets:
            if len(matching_datasets) != 1:
                return set()
            matches.append(old_paths)
    return matches[0] if len(matches) == 1 else set()


def check_change(change: str) -> list[Finding]:
    """Check the change description fits a commit subject and a YAML scalar."""
    if not change.strip() or change != change.strip() or "\n" in change or "\r" in change:
        return [
            Finding(
                LEVEL_ERROR,
                "version",
                "change must be one non-empty line without surrounding whitespace",
            )
        ]
    return []


def check_version(
    dataset: Dataset,
    metadata: dict,
    version: str,
    registered_versions: list[str],
    log: Log,
) -> list[Finding]:
    """Check the version is well-formed, unused and the direct successor.

    "Unused" covers ``metadata.yaml``, the MLflow registry and the git tags of
    the repository and of its remote. The working tree must sit on the latest
    registered version, so a release that never got registered blocks the next.

    Args:
        dataset: The dataset being released.
        metadata: Its current metadata mapping.
        version: The requested version.
        registered_versions: Versions MLflow already holds for this dataset.
        log: Receives git command output.

    Returns:
        Findings; empty when the version may be released.
    """
    try:
        parse_version(version)
    except ValueError as error:
        return [Finding(LEVEL_ERROR, "version", str(error))]

    findings: list[Finding] = []
    current = str(metadata["version"]) if metadata.get("version") else None
    changelog_versions = parse_changelog_versions(metadata)
    tag = dataset.tag(version)
    if version in changelog_versions or version == current:
        findings.append(Finding(LEVEL_ERROR, "version", f"{version} is already in {METADATA_FILE}"))
    if version in registered_versions:
        findings.append(
            Finding(LEVEL_ERROR, "version", f"{version} is already registered in MLflow")
        )
    if _succeeds(dataset.repo, "rev-parse", "-q", "--verify", f"refs/tags/{tag}"):
        findings.append(Finding(LEVEL_ERROR, "version", f"git tag {tag} already exists"))
    try:
        if run_git(dataset.repo, "ls-remote", "--tags", "origin", f"refs/tags/{tag}", log=log):
            findings.append(
                Finding(LEVEL_ERROR, "version", f"git tag {tag} already exists on origin")
            )
    except ReleaseError as error:
        findings.append(
            Finding(LEVEL_ERROR, "version", f"cannot read the tags of origin: {error}")
        )

    try:
        latest = max(changelog_versions, key=parse_version) if changelog_versions else None
        registered = max(registered_versions, key=parse_version) if registered_versions else None
        allowed = build_next_versions(current)
    except ValueError as error:
        return [*findings, Finding(LEVEL_ERROR, "version", f"{METADATA_FILE}: {error}")]
    if latest != current:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "version",
                f"{METADATA_FILE} version {current} is not its latest changelog entry {latest}",
            )
        )
    if registered != current:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "version",
                f"{METADATA_FILE} is at {current or 'no release'} but the latest version "
                f"registered in MLflow is {registered or 'none'}; finish the previous release "
                "or pull the repository first",
            )
        )
    if version not in allowed:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "version",
                f"{version} skips a number; after {current or 'no release'} it must be one of "
                f"{', '.join(allowed)}",
            )
        )
    return findings


def _find_remote_head(repo: Path, log: Log) -> tuple[Optional[str], Optional[str]]:
    """Return origin's default branch and the commit it points at, without fetching."""
    branch = commit = None
    for line in run_git(repo, "ls-remote", "--symref", "origin", "HEAD", log=log).splitlines():
        target, _, name = line.partition("\t")
        if name != "HEAD":
            continue
        if target.startswith("ref: refs/heads/"):
            branch = target.removeprefix("ref: refs/heads/")
        else:
            commit = target
    return branch, commit


def check_repository(dataset: Dataset, log: Log) -> list[Finding]:
    """Check the repository can take the release commit and push it.

    Only ``data/`` may hold uncommitted changes, staged or not: each dataset's
    directory is committed by that dataset's own release, never by this one.

    Args:
        dataset: The dataset being released.
        log: Receives git command output.

    Returns:
        Findings about the DVC setup, the branch and uncommitted changes.
    """
    findings: list[Finding] = []
    if not (dataset.repo / ".dvc").is_dir():
        findings.append(Finding(LEVEL_ERROR, "git", f"{dataset.repo} is not a DVC repository"))
    try:
        branch = run_git(
            dataset.repo, "symbolic-ref", "-q", "--short", "HEAD", log=lambda line: None
        )
    except ReleaseError:
        branch = None
        findings.append(
            Finding(LEVEL_ERROR, "git", "HEAD is detached; check out a branch to release from")
        )
    try:
        default_branch, remote_commit = _find_remote_head(dataset.repo, log)
    except ReleaseError as error:
        findings.append(Finding(LEVEL_ERROR, "git", f"cannot reach origin: {error}"))
    else:
        if branch and default_branch and branch != default_branch:
            findings.append(
                Finding(
                    LEVEL_ERROR,
                    "git",
                    f"releases run on the default branch {default_branch}, not on {branch}",
                )
            )
        # A commit this clone lacks, or one HEAD does not contain, means origin moved on.
        if remote_commit and not _succeeds(
            dataset.repo, "merge-base", "--is-ancestor", remote_commit, "HEAD"
        ):
            findings.append(
                Finding(LEVEL_ERROR, "git", "the branch is behind origin; pull before releasing")
            )

    # The second diff catches a change staged and then reverted in the working tree.
    changed = {
        path
        for arguments in (
            ("diff", "--no-renames", "--name-only", "HEAD"),
            ("diff", "--no-renames", "--cached", "--name-only"),
        )
        for path in run_git(dataset.repo, *arguments, log=log).splitlines()
    }
    data_dir = PurePosixPath(DATA_DIR)
    foreign = sorted(path for path in changed if data_dir not in PurePosixPath(path).parents)
    if foreign:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "git",
                f"{len(foreign)} tracked file(s) outside {DATA_DIR}/ have uncommitted changes, "
                f"e.g. {', '.join(foreign[:5])}; commit or revert them first",
            )
        )
    return findings


def check_layout(
    dataset: Dataset, metadata: dict, version: str, deletions: Sequence[str]
) -> list[Finding]:
    """Check which release units exist and that every absence is intended.

    Args:
        dataset: The dataset being released.
        metadata: Its current metadata mapping.
        version: The requested version.
        deletions: Units the caller asked to delete with this release.

    Returns:
        Errors for a wrong ``name``, an absence that disagrees with the
        deletion list and a split deleted without a Major version; warnings
        for units that were never part of the dataset.
    """
    findings: list[Finding] = []
    if metadata.get("name") != dataset.name:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "layout",
                f"{METADATA_FILE} name {metadata.get('name')!r} does not match "
                f"directory {dataset.name!r}",
            )
        )
    unknown = sorted(set(deletions) - set(UNITS))
    if unknown:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "layout",
                f"the deletion list names {unknown}; it may only hold {', '.join(UNITS)}",
            )
        )
    for unit in UNITS:
        unit_dir = dataset.unit_dir(unit)
        relative = unit_dir.relative_to(dataset.root).as_posix()
        released = pointer_path(unit_dir).is_file()
        if unit in deletions:
            if unit_dir.is_dir():
                message = f"{relative}/ is in the deletion list but still exists; remove it first"
            elif not released:
                message = f"{relative}/ is in the deletion list but was never released"
            else:
                continue
            findings.append(Finding(LEVEL_ERROR, "layout", message))
        elif not unit_dir.is_dir():
            if released:
                findings.append(
                    Finding(
                        LEVEL_ERROR,
                        "layout",
                        f"{relative}/ is missing but not in the deletion list; run `dvc pull` "
                        "to restore it or list it for deletion",
                    )
                )
            else:
                findings.append(
                    Finding(
                        LEVEL_WARNING,
                        "layout",
                        f"{relative}/ is missing; it is not part of this release",
                    )
                )
    deleted_splits = sorted(set(deletions) & set(SPLITS))
    if deleted_splits and VERSION_PATTERN.match(version) and parse_version(version)[1:] != (0, 0):
        findings.append(
            Finding(
                LEVEL_ERROR,
                "layout",
                f"deleting {', '.join(deleted_splits)} needs a Major version, not {version}",
            )
        )
    if not any(dataset.split_dir(split).is_dir() for split in SPLITS):
        findings.append(
            Finding(
                LEVEL_WARNING, "layout", "no split exists; only assets and annotations are released"
            )
        )
    return findings


def _check_reference_file(dataset: Dataset, relative_path: str, digest: str) -> Optional[str]:
    """Return why one referenced file is unacceptable, or ``None`` if it is fine."""
    path = PurePosixPath(relative_path)
    if path.is_absolute() or ".." in path.parts or path.parts[:1] == (SAMPLES_DIR,):
        return f"{relative_path}: must be a dataset-relative path outside {SAMPLES_DIR}/"
    target = dataset.root / path
    if not target.is_file():
        return f"{relative_path}: referenced file does not exist"
    if build_md5(target) != digest:
        return f"{relative_path}: content differs from the recorded {REFERENCE_HASH}"
    return None


def check_split(dataset: Dataset, split: str) -> list[Finding]:
    """Check one split's generated files against the data they read.

    Verifies the sample files and ``_reference.json`` exist and are well-formed,
    every referenced file exists with the recorded digest, and the listed
    files are exactly the outside files the samples read.

    Args:
        dataset: The dataset being released.
        split: The split to check; its directory must exist.

    Returns:
        Findings; empty when the split is consistent.
    """
    split_dir = dataset.split_dir(split)
    try:
        sample_files = find_sample_files(split_dir)
        reference = read_reference(split_dir)
        dependencies = find_dependencies(sample_files)
    except ReleaseError as error:
        return [Finding(LEVEL_ERROR, "samples", f"{split}: {error}")]

    findings: list[Finding] = []
    expected_names = {path.name for path in sample_files} | {REFERENCE_FILE}
    stray = sorted(path.name for path in split_dir.iterdir() if path.name not in expected_names)
    if stray:
        findings.append(
            Finding(
                LEVEL_WARNING,
                "samples",
                f"{split}: unexpected file(s) in the split directory: {', '.join(stray[:5])}",
            )
        )

    with ThreadPoolExecutor(max_workers=16) as pool:
        problems = [
            problem
            for problem in pool.map(
                lambda item: _check_reference_file(dataset, *item),
                sorted(reference.items()),
            )
            if problem
        ]
    if problems:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "reference",
                f"{split}: {len(problems)} referenced file(s) fail, e.g. {'; '.join(problems[:3])}",
            )
        )
    uncovered = sorted(dependencies - set(reference))
    if uncovered:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "reference",
                f"{split}: {REFERENCE_FILE} misses {len(uncovered)} file(s) the samples read, e.g. "
                f"{', '.join(uncovered[:3])}; rerun the build script",
            )
        )
    # An extra entry would let an unrelated file change this split's hash.
    unread = sorted(set(reference) - dependencies)
    if unread:
        findings.append(
            Finding(
                LEVEL_ERROR,
                "reference",
                f"{split}: {REFERENCE_FILE} lists {len(unread)} file(s) the samples do not read, "
                f"e.g. {', '.join(unread[:3])}; rerun the build script",
            )
        )
    return findings


def check_split_overlap(dataset: Dataset, splits: list[str]) -> list[Finding]:
    """Check no two splits reference the same file, by path or by content.

    Args:
        dataset: The dataset being released.
        splits: The splits whose directories exist.

    Returns:
        One error per pair of splits that share referenced files.
    """
    references: dict[str, dict[str, str]] = {}
    for split in splits:
        try:
            references[split] = read_reference(dataset.split_dir(split))
        except ReleaseError:
            # check_split already reported the unreadable reference.
            continue

    findings: list[Finding] = []
    for first, second in itertools.combinations(references, 2):
        paths = sorted(set(references[first]) & set(references[second]))
        digests = set(references[first].values()) & set(references[second].values())
        if not paths and not digests:
            continue
        examples = paths or sorted(
            path for path, digest in references[first].items() if digest in digests
        )
        findings.append(
            Finding(
                LEVEL_ERROR,
                "overlap",
                f"{first} and {second} share {len(paths)} referenced path(s) and "
                f"{len(digests)} file content(s), e.g. {', '.join(examples[:3])}",
            )
        )
    return findings


def check_release(
    dataset: Dataset,
    version: str,
    change: str,
    registered_versions: list[str],
    log: Log,
    deletions: Sequence[str] = (),
    archived: bool = False,
) -> list[Finding]:
    """Run every pre-release check without modifying the repository.

    Args:
        dataset: The dataset being released.
        version: The requested version.
        change: One-line description of what changed.
        registered_versions: Versions MLflow already holds for this dataset.
        log: Receives progress lines and git command output.
        deletions: Units to delete with this release.
        archived: Whether MLflow marks the dataset as archived.

    Returns:
        All findings, errors and warnings alike.
    """
    if not dataset.root.is_dir():
        return [Finding(LEVEL_ERROR, "layout", f"{dataset.root} does not exist")]
    try:
        metadata = read_metadata(dataset.metadata_path)
    except ReleaseError as error:
        return [Finding(LEVEL_ERROR, "layout", str(error))]

    findings = [
        *check_change(change),
        *check_version(dataset, metadata, version, registered_versions, log),
        *check_repository(dataset, log),
        *check_layout(dataset, metadata, version, deletions),
    ]
    if archived:
        findings.append(
            Finding(
                LEVEL_ERROR, "version", f"{dataset.name} is archived; unarchive it to release"
            )
        )
    splits = [split for split in SPLITS if dataset.split_dir(split).is_dir()]
    for split in splits:
        log(f"checking split {split}: sample files, references and digests")
        findings.extend(check_split(dataset, split))
    findings.extend(check_split_overlap(dataset, splits))
    return findings


# ===== Release: steps 3-8 =====

STEPS: dict[int, str] = {
    2: "check",
    3: "dvc add",
    4: "write metadata",
    5: "git add",
    6: "commit and tag",
    7: "push",
    8: "register",
}
STEP_RUNNING = "running"
STEP_DONE = "done"
STEP_FAILED = "failed"
STEP_SKIPPED = "skipped"

OnStep = Callable[[int, str], None]
Register = Callable[[dict], None]


@contextmanager
def _release_lock(repo: Path) -> Iterator[None]:
    """Hold the repository's release lock so two releases never interleave."""
    lock_path = repo / ".dvc" / "tmp" / "deeplore-dataset-release.lock"
    lock_path.parent.mkdir(exist_ok=True)
    with lock_path.open("w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ReleaseError(f"another dataset release is running in {repo}") from error
        yield


def _find_stage_paths(
    dataset: Dataset, log: Log, renamed_paths: Collection[str] = ()
) -> list[str]:
    """List the repo-relative paths step 5 stages: existing or tracked release files."""
    previous_roots = {dataset.repo / Path(*PurePosixPath(path).parts[:2]) for path in renamed_paths}
    if any(root.exists() or root.is_symlink() for root in previous_roots):
        raise ReleaseError("the previous dataset directory reappeared during release; check again")
    candidates = _find_release_files(dataset)
    relative = [dataset.relative(path) for path in candidates]
    tracked = set(
        run_git(
            dataset.repo, "ls-files", "--", *relative, *sorted(renamed_paths), log=log
        ).splitlines()
    )
    return [rel for rel, path in zip(relative, candidates) if path.exists() or rel in tracked] + sorted(
        tracked.intersection(renamed_paths)
    )


def _is_local_release(dataset: Dataset, version: str) -> bool:
    """Whether HEAD already is the release commit of ``version``.

    The tag exists, points at HEAD, and the committed metadata carries the
    version -- the state a failure in step 7 or 8 leaves behind.
    """
    tag = dataset.tag(version)
    quiet: Log = lambda line: None  # noqa: E731
    try:
        tagged = run_git(
            dataset.repo, "rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}", log=quiet
        )
        head = run_git(dataset.repo, "rev-parse", "HEAD", log=quiet)
        committed = run_git(
            dataset.repo, "show", f"{tag}:{dataset.relative(dataset.metadata_path)}", log=quiet
        )
    except ReleaseError:
        return False
    return tagged == head and parse_metadata(committed, tag).get("version") == version


def release_units(
    dataset: Dataset, deletions: Sequence[str], log: Log
) -> dict[str, Optional[str]]:
    """Step 3: put every existing unit into DVC and drop pointers of deleted ones.

    Args:
        dataset: The dataset being released.
        deletions: Units to delete; step 2 verified their directories are gone.
        log: Receives dvc command output.

    Returns:
        Split name -> its directory hash from the ``.dvc`` pointer, ``None``
        for a split that does not exist.
    """
    present = [unit_dir for unit_dir in dataset.unit_dirs if unit_dir.is_dir()]
    if present:
        run_dvc(dataset.repo, "add", *(dataset.relative(unit_dir) for unit_dir in present), log=log)
    for unit in UNITS:
        if unit in deletions:
            pointer = pointer_path(dataset.unit_dir(unit))
            run_dvc(dataset.repo, "remove", dataset.relative(pointer), log=log)
    return {
        split: read_pointer_md5(pointer_path(dataset.split_dir(split)))
        if dataset.split_dir(split).is_dir()
        else None
        for split in SPLITS
    }


def build_record(dataset: Dataset, version: str, released_by: str, log: Log) -> dict:
    """Step 8 input: read the released metadata back from the tag's commit.

    Args:
        dataset: The released dataset.
        version: The released version.
        released_by: System user running the release.
        log: Receives git command output.

    Returns:
        The registration record: metadata fields, the git coordinates and the releaser.
    """
    tag = dataset.tag(version)
    committed = run_git(
        dataset.repo, "show", f"{tag}:{dataset.relative(dataset.metadata_path)}", log=log
    )
    metadata = parse_metadata(committed, tag)
    changes = {
        str(v): str(c) for entry in metadata.get("changelog") or [] for v, c in entry.items()
    }
    return {
        "name": dataset.name,
        "version": version,
        "change": changes.get(version, ""),
        "hashes": parse_hashes(metadata),
        "metadata": metadata,
        "git_repo": run_git(dataset.repo, "remote", "get-url", "origin", log=log),
        "git_tag": tag,
        "git_commit": run_git(dataset.repo, "rev-parse", f"{tag}^{{commit}}", log=log),
        "released_by": released_by,
    }


def _release_rollback(
    dataset: Dataset,
    version: str,
    head: str,
    snapshot: dict[Path, Optional[bytes]],
    log: Log,
    staged_tree: Optional[str] = None,
) -> None:
    """Undo steps 3-6: the tag, the commit and every release file.

    Data that ``dvc add`` moved into the cache stays there; the next release
    reuses it.
    """
    tag = dataset.tag(version)
    try:
        # Step 2 proved the tag did not exist, so one found here is this release's.
        if _succeeds(dataset.repo, "rev-parse", "-q", "--verify", f"refs/tags/{tag}"):
            run_git(dataset.repo, "tag", "-d", tag, log=log)
        # A mixed reset drops the commit and the staged files, never the data.
        run_git(dataset.repo, "reset", "-q", head, log=log)
        if staged_tree is not None:
            run_git(dataset.repo, "read-tree", staged_tree, log=log)
    except ReleaseError as error:
        log(f"could not undo the release commit: {error}")
    for path, content in snapshot.items():
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)


def _release_commit(
    dataset: Dataset,
    version: str,
    change: str,
    deletions: Sequence[str],
    skip_hooks: bool,
    on_step: OnStep,
    log: Log,
) -> None:
    """Steps 3-6: build the local release commit and tag, or leave no trace."""
    head = run_git(dataset.repo, "rev-parse", "HEAD", log=log)
    # Metadata gains a version in step 4, so identify the rename before any writes.
    renamed_paths = _find_renamed_release_paths(dataset, log)
    staged_tree = run_git(dataset.repo, "write-tree", log=log)
    snapshot = {
        path: path.read_bytes() if path.is_file() else None
        for path in _find_release_files(dataset)
    }
    step = 3
    try:
        on_step(3, STEP_RUNNING)
        hashes = release_units(dataset, deletions, log)
        on_step(3, STEP_DONE)

        step = 4
        on_step(4, STEP_RUNNING)
        # Verifiers recompute this hash without DVC; both definitions must agree.
        for split, pointer_hash in hashes.items():
            if pointer_hash and build_dir_md5(dataset.split_dir(split)) != pointer_hash:
                raise ReleaseError(
                    f"{split}: the directory hash computed here differs from {pointer_hash} "
                    "recorded by DVC; the hash definition no longer matches DVC"
                )
        metadata = read_metadata(dataset.metadata_path)
        write_metadata(
            dataset.metadata_path, build_released_metadata(metadata, version, change, hashes)
        )
        on_step(4, STEP_DONE)

        step = 5
        on_step(5, STEP_RUNNING)
        stage_paths = _find_stage_paths(dataset, log, renamed_paths)
        run_git(dataset.repo, "add", "-A", "--", *stage_paths, log=log)
        # A rename staged beforehand already dropped its old paths from the index.
        commit_paths = sorted({*stage_paths, *renamed_paths})
        staged = run_git(
            dataset.repo, "diff", "--no-renames", "--cached", "--name-status", "--", *commit_paths,
            log=log,
        )
        # A renamed dataset's old paths may only leave with this release.
        for line in staged.splitlines():
            status, _, path = line.partition("\t")
            if path in renamed_paths and status != "D":
                raise ReleaseError(
                    "the previous dataset directory reappeared during release; check again"
                )
        on_step(5, STEP_DONE)

        step = 6
        on_step(6, STEP_RUNNING)
        commit = ["commit", "-m", f"dataset({dataset.name}): release {version}, {change}"]
        hooks = ["--no-verify"] if skip_hooks else []
        # By path: whatever else is staged, e.g. another dataset's edits, stays staged.
        run_git(dataset.repo, *commit, *hooks, "--", *commit_paths, log=log)
        run_git(dataset.repo, "tag", "-a", dataset.tag(version), "-m", change, log=log)
        on_step(6, STEP_DONE)
    except Exception:
        on_step(step, STEP_FAILED)
        _release_rollback(dataset, version, head, snapshot, log, staged_tree)
        raise


def find_system_user() -> str:
    """Name of the system user running this process, or its uid when unnamed."""
    try:
        return getpass.getuser()
    except (KeyError, OSError):
        return str(os.getuid())


def release_dataset(
    repo: Path,
    name: str,
    version: str,
    change: str,
    register: Register,
    registered_versions: Optional[list[str]] = None,
    deletions: Sequence[str] = (),
    archived: bool = False,
    dry_run: bool = False,
    skip_hooks: bool = False,
    on_step: OnStep = lambda step, status: None,
    log: Log = print,
) -> dict:
    """Release one dataset version, or with ``dry_run`` only check it.

    Args:
        repo: Root of the git + DVC repository.
        name: Dataset name, the directory under ``data/``.
        version: The version to release, ``vMAJOR.MINOR.PATCH``.
        change: One-line description of what changed.
        register: Receives the registration record once both pushes succeeded.
        registered_versions: Versions MLflow already holds for this dataset.
        deletions: Units (``assets``, ``annotations`` or splits) to delete.
        archived: Whether MLflow marks the dataset as archived.
        dry_run: Run step 2 only and return its findings.
        skip_hooks: Commit with ``--no-verify`` when the release environment
            cannot run the repository's git hooks.
        on_step: Receives ``(step number, status)`` as steps start and end.
        log: Receives progress lines and command output.

    Returns:
        ``{"findings": [...], "record": dict | None, "resumed": bool}``.

    Raises:
        ReleaseError: If a check fails or a step cannot complete.
    """
    dataset = Dataset(repo.resolve(), name)
    if not (dataset.repo / ".git").exists() or not (dataset.repo / ".dvc").is_dir():
        raise ReleaseError(f"{dataset.repo} is not a git + DVC repository")
    with _release_lock(dataset.repo):
        # Registration is the last step, so an unregistered local release is unfinished.
        registered_versions = registered_versions or []
        resumed = version not in registered_versions and _is_local_release(dataset, version)
        if resumed:
            log(f"{dataset.tag(version)} is already committed and tagged locally; resuming at push")
            findings: list[Finding] = []
            for step in range(2, 7):
                on_step(step, STEP_SKIPPED)
        else:
            on_step(2, STEP_RUNNING)
            findings = check_release(
                dataset, version, change, registered_versions, log, deletions, archived
            )
            errors = [finding for finding in findings if finding.level == LEVEL_ERROR]
            on_step(2, STEP_FAILED if errors else STEP_DONE)
            for finding in findings:
                log(f"[{finding.level}] {finding.check}: {finding.message}")
            if errors and not dry_run:
                raise ReleaseError(f"{len(errors)} check(s) failed; nothing was changed", findings)
        result = {
            "findings": [asdict(finding) for finding in findings],
            "record": None,
            "resumed": resumed,
        }
        if dry_run:
            return result
        if not resumed:
            _release_commit(dataset, version, change, deletions, skip_hooks, on_step, log)

        try:
            on_step(7, STEP_RUNNING)
            # Data first: a pushed tag must never point at data the remote lacks.
            run_dvc(dataset.repo, "push", "-R", dataset.relative(dataset.root), log=log)
            run_git(
                dataset.repo,
                "push",
                "--atomic",
                "origin",
                "HEAD",
                f"refs/tags/{dataset.tag(version)}",
                log=log,
            )
            on_step(7, STEP_DONE)
        except ReleaseError as error:
            on_step(7, STEP_FAILED)
            raise ReleaseError(
                f"push failed; the release commit and tag stay local. Release {version} again "
                f"to resume: {error}"
            ) from error

        try:
            on_step(8, STEP_RUNNING)
            result["record"] = build_record(dataset, version, find_system_user(), log)
            register(result["record"])
            on_step(8, STEP_DONE)
        except Exception as error:
            on_step(8, STEP_FAILED)
            raise ReleaseError(
                f"data and git are pushed but registration failed. Release {version} again "
                f"to retry it: {error}"
            ) from error
        log(f"released {dataset.name} {version}")
        return result


# ===== Archive: remove or restore a whole dataset directory =====


def _check_archive_repository(dataset: Dataset, log: Log) -> None:
    """Raise unless the repository can take an archive or unarchive commit."""
    errors = [
        finding.message
        for finding in check_repository(dataset, log)
        if finding.level == LEVEL_ERROR
    ]
    relative = dataset.relative(dataset.root)
    own = {
        path
        for arguments in (("diff", "--name-only", "HEAD"), ("diff", "--cached", "--name-only"))
        for path in run_git(dataset.repo, *arguments, "--", relative, log=log).splitlines()
    }
    if own:
        errors.append(f"{relative} has uncommitted changes, e.g. {', '.join(sorted(own)[:3])}")
    if errors:
        raise ReleaseError("; ".join(errors))


def release_archive(
    repo: Path, name: str, version: str, skip_hooks: bool = False, log: Log = print
) -> None:
    """Archive a dataset: remove ``data/<name>/`` and push ``dataset(<name>): archive``.

    Tags, registered versions and the DVC remote keep every released version.
    The splits must still equal the released ones, so no unreleased samples
    are discarded; ``assets/`` and ``annotations/`` are not compared.

    Args:
        repo: Root of the git + DVC repository.
        name: Dataset name, the directory under ``data/``.
        version: The latest registered version; the working tree must sit on it.
        skip_hooks: Commit with ``--no-verify``.
        log: Receives command output.

    Raises:
        ReleaseError: If the working tree is not a clean copy of ``version``
            or a git command fails; nothing is removed then.
    """
    dataset = Dataset(repo.resolve(), name)
    with _release_lock(dataset.repo):
        metadata = read_metadata(dataset.metadata_path)
        if metadata.get("version") != version:
            raise ReleaseError(
                f"{METADATA_FILE} is at {metadata.get('version')}, not at the latest registered "
                f"version {version}; finish or pull that release first"
            )
        for split, released_hash in parse_hashes(metadata).items():
            split_dir = dataset.split_dir(split)
            if split_dir.is_dir() and build_dir_md5(split_dir) != released_hash:
                raise ReleaseError(
                    f"samples/{split} differs from {version}; archiving would discard it"
                )
        _check_archive_repository(dataset, log)

        head = run_git(dataset.repo, "rev-parse", "HEAD", log=log)
        staged_tree = run_git(dataset.repo, "write-tree", log=log)
        relative = dataset.relative(dataset.root)
        commit = ["commit", "-m", f"dataset({name}): archive"]
        hooks = ["--no-verify"] if skip_hooks else []
        try:
            run_git(dataset.repo, "rm", "-r", "-q", "--", relative, log=log)
            run_git(dataset.repo, *commit, *hooks, "--", relative, log=log)
            run_git(dataset.repo, "push", "origin", "HEAD", log=log)
        except ReleaseError:
            # Nothing was published: bring the commit, the index and the tracked files back.
            run_git(dataset.repo, "reset", "-q", head, log=log)
            run_git(dataset.repo, "read-tree", staged_tree, log=log)
            run_git(dataset.repo, "checkout", "--", relative, log=log)
            raise
        # What is left is data DVC ignores; the cache and the remote keep it.
        shutil.rmtree(dataset.root, ignore_errors=True)


def release_unarchive(
    repo: Path, name: str, commit: str, skip_hooks: bool = False, log: Log = print
) -> bool:
    """Undo an archive: restore ``data/<name>/`` and push ``dataset(<name>): unarchive``.

    Args:
        repo: Root of the git + DVC repository.
        name: Dataset name, the directory under ``data/``.
        commit: Release commit or tag of the latest version to restore from.
        skip_hooks: Commit with ``--no-verify``.
        log: Receives command output.

    Returns:
        Whether the data came back from the local DVC cache; when it did not,
        ``dvc pull -R data/<name>`` restores it.

    Raises:
        ReleaseError: If the directory exists or a git command fails.
    """
    dataset = Dataset(repo.resolve(), name)
    with _release_lock(dataset.repo):
        if dataset.root.exists():
            raise ReleaseError(f"{dataset.root} already exists")
        _check_archive_repository(dataset, log)

        head = run_git(dataset.repo, "rev-parse", "HEAD", log=log)
        staged_tree = run_git(dataset.repo, "write-tree", log=log)
        relative = dataset.relative(dataset.root)
        message = ["commit", "-m", f"dataset({name}): unarchive"]
        hooks = ["--no-verify"] if skip_hooks else []
        try:
            run_git(dataset.repo, "checkout", commit, "--", relative, log=log)
            run_git(dataset.repo, *message, *hooks, "--", relative, log=log)
            run_git(dataset.repo, "push", "origin", "HEAD", log=log)
        except ReleaseError:
            run_git(dataset.repo, "reset", "-q", head, log=log)
            run_git(dataset.repo, "read-tree", staged_tree, log=log)
            shutil.rmtree(dataset.root, ignore_errors=True)
            raise
        try:
            run_dvc(dataset.repo, "checkout", "-R", relative, log=log)
        except ReleaseError as error:
            log(f"the local DVC cache lacks the data; run `dvc pull -R {relative}`: {error}")
            return False
        return True


# ===== CLI =====

API_PATH = "/api/2.0/deeplore/datasets"


def _call_api(tracking_uri: str, path: str, payload: Optional[dict] = None) -> dict:
    """Call the tracking server's dataset API: GET, or POST when ``payload`` is given."""
    request = urllib.request.Request(
        tracking_uri.rstrip("/") + API_PATH + path,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ReleaseError(
            f"{request.full_url} answered {error.code}: {error.read().decode('utf-8', 'replace')}"
        ) from error
    except urllib.error.URLError as error:
        raise ReleaseError(f"cannot reach {request.full_url}: {error.reason}") from error


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "command",
        choices=("check", "release"),
        help="check runs step 2 only; release runs steps 2-8.",
    )
    parser.add_argument("--repo", type=Path, required=True, help="Dataset repository root.")
    parser.add_argument("--name", required=True, help="Dataset name under data/.")
    parser.add_argument("--version", required=True, help="Version to release, vMAJOR.MINOR.PATCH.")
    parser.add_argument("--change", required=True, help="One-line description of what changed.")
    parser.add_argument(
        "--delete",
        action="append",
        default=[],
        choices=UNITS,
        help="Unit to delete with this release; repeat for several.",
    )
    parser.add_argument(
        "--tracking-uri",
        default=os.environ.get("MLFLOW_TRACKING_URI"),
        help="MLflow tracking server that registers the release (default: $MLFLOW_TRACKING_URI).",
    )
    parser.add_argument("--skip-hooks", action="store_true", help="Commit with --no-verify.")
    return parser.parse_args()


def main() -> None:
    """Run the command-line interface."""
    args = parse_args()
    if not args.tracking_uri:
        sys.exit("--tracking-uri or MLFLOW_TRACKING_URI is required to check and register versions")
    try:
        registered = _call_api(args.tracking_uri, f"/{args.name}/versions")
        result = release_dataset(
            repo=args.repo,
            name=args.name,
            version=args.version,
            change=args.change,
            register=lambda record: _call_api(args.tracking_uri, "/versions", record),
            registered_versions=[row["version"] for row in registered["versions"]],
            deletions=args.delete,
            archived=bool(registered.get("archived")),
            dry_run=args.command == "check",
            skip_hooks=args.skip_hooks,
        )
    except ReleaseError as error:
        sys.exit(f"release failed: {error}")
    if any(finding["level"] == LEVEL_ERROR for finding in result["findings"]):
        sys.exit("check failed")


if __name__ == "__main__":
    main()
