"""Collect and aggregate metrics for NVIDIA GPUs used by the training process.

Sections: GPU metrics collection.
Naming: collect_* samples values; aggregate_* averages sampled values;
get_* resolves the process identities used to select devices.
"""

import logging
import sys

import psutil

from mlflow.system_metrics.metrics.base_metrics_monitor import BaseMetricsMonitor

_logger = logging.getLogger(__name__)

try:
    import pynvml
except ImportError:
    # If `pynvml` is not installed, a warning will be logged at monitor instantiation.
    # We don't log a warning here to avoid spamming warning at every import.
    pass


# ===== GPU metrics collection =====


class GPUMonitor(BaseMetricsMonitor):
    """Collect device metrics only for this process and its training workers.

    Devices retain their physical NVIDIA indices. Utilization is a percentage,
    memory is measured in mebibytes, and power is measured in watts.
    """

    # ---- Initialization ----

    def __init__(self) -> None:
        if "pynvml" not in sys.modules:
            # Only instantiate if `pynvml` is installed.
            raise ImportError(
                "`pynvml` is not installed, to log GPU metrics please run `pip install pynvml` "
                "to install it."
            )
        try:
            # `nvmlInit()` will fail if no GPU is found.
            pynvml.nvmlInit()
        except pynvml.NVMLError as e:
            raise RuntimeError(f"Failed to initialize NVML, skip logging GPU metrics: {e}")

        super().__init__()
        self._training_process = psutil.Process()
        self._used_gpu_indices: set[int] = set()
        self._unverified_gpu_indices: set[int] = set()
        self._reported_worker_error = False
        self.num_gpus = pynvml.nvmlDeviceGetCount()
        self.gpu_handles = [pynvml.nvmlDeviceGetHandleByIndex(i) for i in range(self.num_gpus)]

    # ---- Sampling and aggregation ----

    def _get_process_ids(self) -> set[int]:
        process_ids = {self._training_process.pid}
        try:
            process_ids.update(child.pid for child in self._training_process.children(recursive=True))
        except psutil.Error:
            if not self._reported_worker_error:
                _logger.warning(
                    "Cannot inspect training workers; GPUs used only by workers may be skipped."
                )
                self._reported_worker_error = True
        return process_ids

    def collect_metrics(self) -> None:
        """Sample utilization, memory, and power for confirmed training devices."""
        process_ids = self._get_process_ids()
        for i, handle in enumerate(self.gpu_handles):
            if i not in self._used_gpu_indices:
                try:
                    processes = pynvml.nvmlDeviceGetComputeRunningProcesses(handle)
                except pynvml.NVMLError:
                    if i not in self._unverified_gpu_indices:
                        _logger.warning(
                            "Skipping GPU %s metrics until its training processes can be identified.",
                            i,
                        )
                        self._unverified_gpu_indices.add(i)
                    continue
                if not any(process.pid in process_ids for process in processes):
                    continue
                # Retain confirmed devices across idle periods between training steps.
                self._used_gpu_indices.add(i)

            try:
                memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
                self._metrics[f"gpu_{i}_mem"].append(memory.used / 2**20)
            except pynvml.NVMLError as e:
                _logger.warning(f"Encountered error {e} when trying to collect GPU memory metrics.")

            try:
                device_utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
                self._metrics[f"gpu_{i}_util"].append(device_utilization.gpu)
            except pynvml.NVMLError as e:
                _logger.warning(
                    f"Encountered error {e} when trying to collect GPU utilization metrics."
                )

            try:
                power_milliwatts = pynvml.nvmlDeviceGetPowerUsage(handle)
                self._metrics[f"gpu_{i}_power"].append(power_milliwatts / 1000)
            except pynvml.NVMLError as e:
                _logger.warning(
                    f"Encountered error {e} when trying to collect GPU power usage metrics."
                )

    def aggregate_metrics(self) -> dict[str, float]:
        """Return the mean value for each collected device metric."""
        return {k: round(sum(v) / len(v), 1) for k, v in self._metrics.items()}
