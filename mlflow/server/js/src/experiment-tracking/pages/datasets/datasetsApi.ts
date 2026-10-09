/**
 * Dataset API: response types, then requests to the Deeplore dataset endpoints.
 * Naming: fetch* reads the tracking server; start* triggers a server-side job;
 * create*, delete*, archive* and unarchive* change a dataset's registration.
 */
import { deleteJson, getJson, postJson } from '../../../common/utils/FetchUtils';

// ===== Response types =====

export const DATASET_SPLITS = ['train', 'val', 'test'] as const;
export type DatasetSplit = typeof DATASET_SPLITS[number];
export type DatasetHashes = Partial<Record<DatasetSplit, string | null>>;
// Units a release may delete: the raw data directories and each split.
export const DATASET_UNITS = ['assets', 'annotations', ...DATASET_SPLITS] as const;
export type DatasetStatus = 'unreleased' | 'released' | 'archived';

export interface DatasetMetadata {
  name: string;
  source?: string;
  version?: string | null;
  metrics?: string[];
  // A mapping; metadata written before the mapping form holds a list of single-split mappings.
  hashes?: DatasetHashes | DatasetHashes[];
  changelog?: Record<string, string>[];
}

export interface DatasetVersion {
  name: string;
  version: string;
  change: string | null;
  hashes: DatasetHashes;
  metadata: DatasetMetadata;
  git_repo: string | null;
  git_tag: string | null;
  git_commit: string | null;
  released_by: string | null;
  created_at: number;
}

export interface DatasetSummary {
  name: string;
  repo: string | null;
  status: DatasetStatus;
  // Which release units exist on disk: assets, annotations and each split.
  units: Record<string, boolean>;
  metadata: DatasetMetadata | null;
  changelog?: Record<string, string>[];
  next_versions: string[];
  // A version committed locally that MLflow does not hold yet; it is retried, not superseded.
  unfinished_version: string | null;
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
  deletions: string[];
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

const deleteDeeploreJson = <T>(path: string) => deleteJson({ relativeUrl: `${API}${path}`, data: {} }) as Promise<T>;

const datasetPath = (name: string) => `/datasets/${encodeURIComponent(name)}`;

export interface DatasetListing {
  repos: string[];
  datasets: DatasetSummary[];
}

export const fetchDatasets = () => getDeeploreJson<DatasetListing>('/datasets');

/** Archived datasets are hidden from the default listing. */
export const fetchDatasetsWithArchived = () =>
  getDeeploreJson<DatasetListing>('/datasets', { include_archived: 'true' });

export const createDataset = (repo: string, name: string, source: string, metrics: string[]) =>
  postDeeploreJson<{ dataset: DatasetSummary }>('/datasets', { repo, name, source, metrics }).then(
    (response) => response.dataset,
  );

export const deleteDataset = (name: string) => deleteDeeploreJson<{ deleted: string }>(datasetPath(name));

export const archiveDataset = (name: string) => postDeeploreJson<unknown>(`${datasetPath(name)}/archive`, {});

export const unarchiveDataset = (name: string) =>
  postDeeploreJson<{ data_restored: boolean }>(`${datasetPath(name)}/unarchive`, {});

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

export const startDatasetRelease = (
  name: string,
  version: string,
  change: string,
  deletions: string[],
  dryRun: boolean,
) =>
  postDeeploreJson<{ job: ReleaseJob }>(`${datasetPath(name)}/releases`, {
    version,
    change,
    deletions,
    dry_run: dryRun,
  }).then((response) => response.job);

/** Read split hashes from the mapping form or from the earlier list of single-split mappings. */
export const getDatasetHashes = (metadata?: DatasetMetadata | null): DatasetHashes =>
  Array.isArray(metadata?.hashes) ? Object.assign({}, ...metadata.hashes) : metadata?.hashes ?? {};
