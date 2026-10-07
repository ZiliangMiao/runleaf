"""Collect and aggregate host CPU and memory utilization.

Sections: host metrics collection.
Naming: collect_* samples values; aggregate_* averages sampled values.
"""

import psutil

from mlflow.system_metrics.metrics.base_metrics_monitor import BaseMetricsMonitor


# ===== Host metrics collection =====


class CPUMonitor(BaseMetricsMonitor):
    """Collect host CPU and memory utilization as percentages."""

    # ---- Sampling and aggregation ----

    def collect_metrics(self) -> None:
        """Sample the host CPU and memory utilization percentages."""
        self._metrics["cpu_util"].append(psutil.cpu_percent())
        self._metrics["mem"].append(psutil.virtual_memory().percent)

    def aggregate_metrics(self) -> dict[str, float]:
        """Return the mean percentage for each collected metric."""
        return {k: round(sum(v) / len(v), 1) for k, v in self._metrics.items()}
