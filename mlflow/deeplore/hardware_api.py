"""Live hardware status of the tracking server's host, read through nvitop.

nvitop (with psutil and nvidia-ml-py) is an optional dependency imported per
request: a server without it keeps serving everything else and answers this
endpoint with an explanatory error. GPUs are read through NVML, so a
containerized server needs the NVIDIA runtime; GPU processes started outside
the container show their user and command only when it shares the host's
process namespace.

Disks: ``DEEPLORE_HARDWARE_DISKS`` lists ``[label=]path`` entries separated by
``os.pathsep``, each reporting the filesystem that holds ``path`` under
``label`` (the path itself by default). Without it, every physical partition
is reported once, under the mount point it was first mounted at.

Sections: Readers, Snapshot, Handler, Routes.

Naming table: ``read_*`` samples one resource, ``build_*`` assembles the
response, ``handle_*`` serves a request and ``register_*`` attaches routes.
"""

from __future__ import annotations

import os
import socket
import threading
import time
from types import ModuleType
from typing import Any, Callable, Optional

from flask import Flask, Response, jsonify

from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import NOT_IMPLEMENTED

API_PREFIXES: tuple[str, ...] = ("/api/2.0/deeplore", "/ajax-api/2.0/deeplore")
DISKS_ENV = "DEEPLORE_HARDWARE_DISKS"
# The first CPU sample of a process has no earlier one to compare with.
_CPU_PRIMING_SECONDS = 0.2
_cpu_primed = threading.Event()
# NVML stays missing until the server restarts; remember it to avoid logging it every poll.
_gpu_unavailable: Optional[str] = None

# ===== Readers =====


def _value(value: Any) -> Any:
    """Map nvitop's ``N/A`` marker to None."""
    from nvitop import NA

    return None if value is NA else value


def read_cpu(host: ModuleType) -> dict[str, Any]:
    """Sample overall and per-core utilization, core count and load average."""
    interval = None if _cpu_primed.is_set() else _CPU_PRIMING_SECONDS
    per_cpu = host.cpu_percent(interval=interval, percpu=True)
    _cpu_primed.set()
    return {
        "percent": round(sum(per_cpu) / len(per_cpu), 1) if per_cpu else None,
        "per_cpu": per_cpu,
        "count": host.cpu_count(),
        "load_average": list(host.load_average() or ()),
    }


def read_memory(host: ModuleType) -> dict[str, Any]:
    """Sample physical memory and swap in bytes."""
    memory = host.virtual_memory()
    swap = host.swap_memory()
    return {
        "memory": {
            "total": memory.total,
            "used": memory.total - memory.available,
            "available": memory.available,
            "percent": memory.percent,
        },
        "swap": {"total": swap.total, "used": swap.used, "percent": swap.percent},
    }


def _find_disk_paths(host: ModuleType) -> list[tuple[str, str]]:
    """Return ``(label, path)`` pairs from the environment or the physical partitions."""
    entries = [entry for entry in os.environ.get(DISKS_ENV, "").split(os.pathsep) if entry]
    if entries:
        return [
            (label, path) if separator else (entry, entry)
            for entry in entries
            for label, separator, path in [entry.partition("=")]
        ]
    mountpoints: dict[str, str] = {}
    for partition in host.disk_partitions(all=False):
        # Mounts are listed in mount order, so later bind mounts of a device are skipped.
        if partition.fstype not in ("squashfs", "iso9660"):
            mountpoints.setdefault(partition.device, partition.mountpoint)
    return [(mountpoint, mountpoint) for mountpoint in sorted(mountpoints.values())]


def read_disks(host: ModuleType) -> list[dict[str, Any]]:
    """Sample the usage of each reported filesystem; unreadable paths carry an error."""
    disks = []
    for label, path in _find_disk_paths(host):
        try:
            usage = host.disk_usage(path)
        except OSError as error:
            disks.append({"label": label, "error": error.strerror or str(error)})
            continue
        disks.append(
            {
                "label": label,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": usage.percent,
            }
        )
    return disks


def _read_gpu_processes(device: Any) -> list[dict[str, Any]]:
    from nvitop import GpuProcess

    snapshots = GpuProcess.take_snapshots(device.processes().values(), failsafe=True)
    return [
        {
            "pid": snapshot.pid,
            "username": _value(snapshot.username),
            "command": _value(snapshot.command),
            "type": _value(snapshot.type),
            "gpu_memory": _value(snapshot.gpu_memory),
            "gpu_sm_utilization": _value(snapshot.gpu_sm_utilization),
            "cpu_percent": _value(snapshot.cpu_percent),
            "host_memory": _value(snapshot.host_memory),
            "running_time": _value(snapshot.running_time_human),
        }
        for snapshot in sorted(snapshots, key=lambda snapshot: snapshot.pid)
    ]


def _read_gpu(device: Any) -> dict[str, Any]:
    power_usage = _value(device.power_usage())
    power_limit = _value(device.power_limit())
    return {
        "index": device.index,
        "name": _value(device.name()),
        "uuid": _value(device.uuid()),
        "bus_id": _value(device.bus_id()),
        "utilization": _value(device.gpu_utilization()),
        "memory_used": _value(device.memory_used()),
        "memory_total": _value(device.memory_total()),
        "temperature": _value(device.temperature()),
        # NVML reports milliwatts.
        "power_usage": power_usage / 1000 if power_usage is not None else None,
        "power_limit": power_limit / 1000 if power_limit is not None else None,
        "fan_speed": _value(device.fan_speed()),
        "processes": _read_gpu_processes(device),
    }


def read_gpus() -> dict[str, Any]:
    """Sample every GPU through NVML; a missing driver is reported, not raised."""
    global _gpu_unavailable
    from nvitop import Device, libnvml

    devices: list[dict[str, Any]] = []
    error = _gpu_unavailable
    if error is None:
        try:
            devices = [_read_gpu(device) for device in Device.all()]
        except (libnvml.NVMLError_LibraryNotFound, libnvml.NVMLError_DriverNotLoaded) as exception:
            error = _gpu_unavailable = f"NVML is unavailable: {exception}"
        except libnvml.NVMLError as exception:
            error = str(exception)
    return {
        "driver_version": _value(Device.driver_version()) if error is None else None,
        "cuda_driver_version": _value(Device.cuda_driver_version()) if error is None else None,
        "devices": devices,
        "error": error,
    }


# ===== Snapshot =====


def build_hardware_snapshot() -> dict[str, Any]:
    """Assemble one sample of the host's CPU, memory, disks and GPUs.

    Raises:
        MlflowException: If nvitop is not installed in the server environment.
    """
    try:
        from nvitop import host
    except ImportError as error:
        raise MlflowException(
            "hardware monitoring needs nvitop installed in the tracking server environment",
            error_code=NOT_IMPLEMENTED,
        ) from error
    return {
        "timestamp": time.time(),
        "hostname": socket.gethostname(),
        "cpu": read_cpu(host),
        **read_memory(host),
        "disks": read_disks(host),
        "gpus": read_gpus(),
    }


# ===== Handler =====


def handle_get_hardware() -> Response:
    """Return the current hardware snapshot."""
    return jsonify(build_hardware_snapshot())


# ===== Routes =====

ROUTES: tuple[tuple[str, Callable[..., Response], str], ...] = (
    ("/hardware", handle_get_hardware, "GET"),
)


def register_hardware_routes(app: Flask) -> None:
    """Attach the hardware route under both tracking server API prefixes.

    Args:
        app: The MLflow tracking server application.
    """
    from mlflow.server.handlers import _add_static_prefix, catch_mlflow_exception

    for path, handler, method in ROUTES:
        view = catch_mlflow_exception(handler)
        for prefix in API_PREFIXES:
            app.add_url_rule(
                _add_static_prefix(prefix + path),
                handler.__name__,
                view,
                methods=[method],
            )
