/**
 * Dataset release API: response types, then requests to the Deeplore dataset endpoints.
 * Naming: fetch_* reads the tracking server; start_* triggers a server-side job.
 */
import { getJson, postJson } from '../../../common/utils/FetchUtils';

// ===== Response types =====

export const DATASET_SPLITS = ['train', 'val', 'test'] as const;
export type DatasetSplit = typeof DATASET_SPLITS[number];
export type DatasetHashes = Partial<Record<DatasetSplit, string | null>>;

export interface DatasetMetadata {
  name: string;
  source?: string;
  root?: string;
  version?: string | null;
  metrics?: string[];
  hashes?: DatasetHashes[];
  changelog?: Record<string, string>[];
}

export interface DatasetVersion {
  name: string;
  version: string;
  change: string;
  hashes: DatasetHashes;
  metadata: DatasetMetadata;
  git_repo: string;
  git_tag: string;
  git_commit: string;
  created_at: number;
}

export interface DatasetSummary {
  name: string;
  repo: string | null;
  // Which release units exist on disk: assets, annotations and each split.
  units: Record<string, boolean>;
  metadata: DatasetMetadata | null;
  changelog?: Record<string, string>[];
  next_versions: string[];
  error: string | null;
  latest_release: DatasetVersion | null;
}

export type ReleaseJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ReleaseFinding {
  level: 'error' | 'warning';
  check: string;
  message: string;
}

export interface ReleaseJob {
  job_id: string;
  repo: string;
  name: string;
  version: string;
  change: string;
  dry_run: boolean;
  status: ReleaseJobStatus;
  // Step number (2-8) to running / done / failed / skipped.
  steps: Record<string, string>;
  findings: ReleaseFinding[];
  log: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export const isReleaseJobActive = (job?: ReleaseJob) => job?.status === 'pending' || job?.status === 'running';

// ===== Requests =====

const API = 'ajax-api/2.0/deeplore';

// FetchUtils resolves to unknown; these endpoints answer the shapes declared above.
const getDeeploreJson = <T>(path: string, data?: Record<string, string>) =>
  getJson({ relativeUrl: `${API}${path}`, data }) as Promise<T>;

const postDeeploreJson = <T>(path: string, data: Record<string, unknown>) =>
  postJson({ relativeUrl: `${API}${path}`, data }) as Promise<T>;

export const fetchDatasets = () => getDeeploreJson<{ repos: string[]; datasets: DatasetSummary[] }>('/datasets');

export const fetchDatasetVersions = (name: string) =>
  getDeeploreJson<{ versions: DatasetVersion[] }>(`/datasets/${encodeURIComponent(name)}/versions`).then(
    (response) => response.versions,
  );

export const fetchDatasetReleases = (name: string) =>
  getDeeploreJson<{ jobs: ReleaseJob[] }>('/dataset-releases', { name }).then((response) => response.jobs);

export const fetchDatasetRelease = (jobId: string) =>
  getDeeploreJson<{ job: ReleaseJob }>(`/dataset-releases/${encodeURIComponent(jobId)}`).then(
    (response) => response.job,
  );

export const startDatasetRelease = (name: string, version: string, change: string, dryRun: boolean) =>
  postDeeploreJson<{ job: ReleaseJob }>(`/datasets/${encodeURIComponent(name)}/releases`, {
    version,
    change,
    dry_run: dryRun,
  }).then((response) => response.job);
