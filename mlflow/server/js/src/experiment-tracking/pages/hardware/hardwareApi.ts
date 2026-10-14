/**
 * Hardware API: the snapshot the tracking server reads through nvitop, then its request.
 * Sizes are bytes, power is watts and utilizations are percentages; null marks a value the device does not report.
 * Naming: fetch* reads the tracking server.
 */
import { getJson } from '../../../common/utils/FetchUtils';

// ===== Response types =====

export interface GpuProcess {
  pid: number;
  username: string | null;
  command: string | null;
  type: string | null;
  gpu_memory: number | null;
  gpu_sm_utilization: number | null;
  cpu_percent: number | null;
  host_memory: number | null;
  running_time: string | null;
}

export interface GpuDevice {
  index: number;
  name: string | null;
  uuid: string | null;
  bus_id: string | null;
  utilization: number | null;
  memory_used: number | null;
  memory_total: number | null;
  temperature: number | null;
  power_usage: number | null;
  power_limit: number | null;
  fan_speed: number | null;
  processes: GpuProcess[];
}

export interface DiskUsage {
  label: string;
  total?: number;
  used?: number;
  free?: number;
  percent?: number;
  error?: string;
}

export interface HardwareSnapshot {
  timestamp: number;
  hostname: string;
  cpu: { percent: number | null; per_cpu: number[]; count: number | null; load_average: number[] };
  memory: { total: number; used: number; available: number; percent: number };
  swap: { total: number; used: number; percent: number };
  disks: DiskUsage[];
  gpus: {
    driver_version: string | null;
    cuda_driver_version: string | null;
    devices: GpuDevice[];
    error: string | null;
  };
}

// ===== Request =====

export const fetchHardware = () =>
  getJson({ relativeUrl: 'ajax-api/2.0/deeplore/hardware' }) as Promise<HardwareSnapshot>;
