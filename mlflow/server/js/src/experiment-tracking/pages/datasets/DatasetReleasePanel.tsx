/**
 * Dataset release panel: shared labels, job progress, then the release form.
 * Naming: start* triggers a job; get* reads a display value.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  LegacySelect,
  Modal,
  Spinner,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import {
  DATASET_UNITS,
  fetchDatasetRelease,
  fetchDatasetReleases,
  isReleaseJobActive,
  startDatasetRelease,
  type DatasetSummary,
  type ReleaseJob,
} from './datasetsApi';

// ===== Shared =====

const BUMP_LABELS = ['patch', 'minor', 'major'];
const POLL_INTERVAL_MS = 1500;

export const getErrorMessage = (error: unknown) =>
  error instanceof ErrorWrapper ? error.getMessageField() : error instanceof Error ? error.message : String(error);

// ===== Job progress =====

const ReleaseJobProgress = ({ job }: { job: ReleaseJob }) => {
  const { theme } = useDesignSystemTheme();
  const action = job.dry_run ? 'Check' : 'Release';
  const status = {
    pending: 'Waiting to start',
    running: 'In progress',
    succeeded: job.dry_run ? 'Passed' : 'Completed',
    failed: 'Failed',
  }[job.status];
  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }} aria-label="Release job">
      <div css={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.sm }}>
        {isReleaseJobActive(job) && <Spinner size="small" />}
        <span role="status" aria-live="polite" css={{ color: theme.colors.textSecondary }}>
          {action} {job.version}: {status}
        </span>
      </div>
      {(job.status === 'failed' || job.error) && (
        <Alert
          componentId="mlflow.datasets.release.failed"
          type="error"
          closable={false}
          message={`${action} ${job.status === 'failed' ? 'failed' : 'error'}`}
          description={job.error && <span css={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{job.error}</span>}
        />
      )}
      {job.findings.map((finding, index) => (
        <Alert
          key={index}
          componentId="mlflow.datasets.release.finding"
          type={finding.level === 'error' ? 'error' : 'warning'}
          closable={false}
          message={`${finding.check}: ${finding.message}`}
        />
      ))}
    </div>
  );
};

// ===== Form =====

/** Check or release one dataset and follow the job the server runs for it. */
export const DatasetReleasePanel = ({ dataset, onReleased }: { dataset: DatasetSummary; onReleased: () => void }) => {
  const { theme } = useDesignSystemTheme();
  const [version, setVersion] = useState(dataset.next_versions[0] ?? '');
  const [change, setChange] = useState('');
  const [deletions, setDeletions] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string>();
  const [restoredJobId, setRestoredJobId] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const recentJobs = useQuery(['deeplore-dataset-releases', dataset.name], () => fetchDatasetReleases(dataset.name), {
    refetchOnWindowFocus: false,
    retry: false,
  });
  // Restore only active jobs, then keep their results for this visit.
  useEffect(() => {
    if (!jobId && !restoredJobId && !recentJobs.isFetching && !recentJobs.isError) {
      setRestoredJobId(recentJobs.data?.find(isReleaseJobActive)?.job_id);
    }
  }, [jobId, restoredJobId, recentJobs.data, recentJobs.isFetching, recentJobs.isError]);
  const shownJobId = jobId ?? restoredJobId;
  const job = useQuery(['deeplore-dataset-release', shownJobId], () => fetchDatasetRelease(shownJobId as string), {
    enabled: Boolean(shownJobId),
    refetchInterval: (data) => (isReleaseJobActive(data) ? POLL_INTERVAL_MS : false),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const jobIsActive = isReleaseJobActive(job.data);

  // A finished release changes the dataset's version, hashes and history.
  const releasedJobId = job.data && !job.data.dry_run && job.data.status === 'succeeded' ? job.data.job_id : undefined;
  const notifiedJobId = useRef<string>();
  useEffect(() => {
    if (releasedJobId && notifiedJobId.current !== releasedJobId) {
      notifiedJobId.current = releasedJobId;
      // The description belongs to the version just released here, not to the next one.
      if (releasedJobId === jobId) {
        setChange('');
        setDeletions([]);
      }
      onReleased();
    }
  }, [releasedJobId, jobId, onReleased]);

  // The valid successors change once a release lands.
  const nextVersions = dataset.next_versions;
  useEffect(() => {
    if (!nextVersions.includes(version)) {
      setVersion(nextVersions[0] ?? '');
    }
  }, [nextVersions, version]);

  // Only a directory that is gone can be deleted; one left unlisted fails the check instead.
  const missingUnits = DATASET_UNITS.filter((unit) => dataset.units[unit] === false);
  const unfinishedVersion = dataset.unfinished_version;
  const unfinishedChange = (dataset.metadata?.changelog ?? [])
    .map((entry) => (unfinishedVersion ? entry[unfinishedVersion] : undefined))
    .find(Boolean);

  const startJob = async (dryRun: boolean) => {
    setSubmitting(true);
    setStartError(undefined);
    try {
      // Releasing the unfinished version again resumes it at the failed step.
      const started = unfinishedVersion
        ? await startDatasetRelease(dataset.name, unfinishedVersion, unfinishedChange ?? unfinishedVersion, [], false)
        : await startDatasetRelease(
            dataset.name,
            version,
            change.trim(),
            deletions.filter((unit) => missingUnits.some((missing) => missing === unit)),
            dryRun,
          );
      setJobId(started.job_id);
    } catch (error) {
      setStartError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };
  const disabled =
    submitting || jobIsActive || !version || !change.trim() || !dataset.repo || Boolean(unfinishedVersion);
  const formHint = !dataset.repo
    ? 'A local repository is required to check or release this dataset.'
    : unfinishedVersion
    ? 'The previous release must be registered before the next one can start.'
    : !version
    ? 'No next release version is available.'
    : jobIsActive
    ? 'A job is running. Wait for it to finish before starting another.'
    : !change.trim()
    ? undefined
    : 'Check validates the dataset without changing it. Release asks for confirmation.';

  return (
    <section
      aria-label="Release dataset version"
      css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md, minWidth: 0 }}
    >
      <div
        css={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.borders.borderRadiusMd,
          padding: theme.spacing.md,
        }}
      >
        <div css={{ fontWeight: theme.typography.typographyBoldFontWeight, marginBottom: theme.spacing.md }}>
          Release a new version
        </div>
        <div css={{ display: 'flex', gap: theme.spacing.md, alignItems: 'end', flexWrap: 'wrap' }}>
          <div css={{ flex: '0 1 200px', minWidth: 0 }}>
            <label htmlFor="dataset-release-version" css={{ display: 'block', marginBottom: 4 }}>
              New version
            </label>
            <LegacySelect
              id="dataset-release-version"
              aria-label="New version"
              aria-describedby={formHint ? 'dataset-release-hint' : undefined}
              value={version}
              onChange={(value: string) => setVersion(value)}
              options={nextVersions.map((next, index) => ({
                value: next,
                label: `${next} (${nextVersions.length === 1 ? 'first release' : BUMP_LABELS[index]})`,
              }))}
              css={{ width: '100%' }}
            />
          </div>
          <div css={{ flex: '1 1 280px', minWidth: 0 }}>
            <label htmlFor="dataset-release-change" css={{ display: 'block', marginBottom: 4 }}>
              Change description
            </label>
            <Input
              id="dataset-release-change"
              componentId="mlflow.datasets.release.change"
              aria-label="Change description"
              aria-describedby={formHint ? 'dataset-release-hint' : undefined}
              placeholder="Enter a change description to enable checks and release."
              value={change}
              onChange={(event) => setChange(event.target.value)}
            />
          </div>
          <Button componentId="mlflow.datasets.release.check" disabled={disabled} onClick={() => startJob(true)}>
            Check
          </Button>
          <Button
            componentId="mlflow.datasets.release.release"
            type="primary"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            Release
          </Button>
        </div>
        {missingUnits.length > 0 && !unfinishedVersion && (
          <div
            aria-label="Deletion list"
            css={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.md, marginTop: theme.spacing.md }}
          >
            <span css={{ color: theme.colors.textSecondary }}>Delete with this release</span>
            {missingUnits.map((unit) => (
              <Checkbox
                key={unit}
                componentId="mlflow.datasets.release.deletion"
                isChecked={deletions.includes(unit)}
                onChange={(checked) =>
                  setDeletions((current) =>
                    checked ? [...current.filter((listed) => listed !== unit), unit] : current.filter((listed) => listed !== unit),
                  )
                }
              >
                {unit}
              </Checkbox>
            ))}
            <span css={{ color: theme.colors.textSecondary }}>
              A missing directory that is not listed fails the check. Deleting a split needs a major version.
            </span>
          </div>
        )}
        {formHint && (
          <div id="dataset-release-hint" css={{ color: theme.colors.textSecondary, marginTop: theme.spacing.md }}>
            {formHint}
          </div>
        )}
      </div>
      {unfinishedVersion && (
        <Alert
          componentId="mlflow.datasets.release.unfinished"
          type="warning"
          closable={false}
          message={`Release ${unfinishedVersion} is committed but not registered`}
          description={
            <div css={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.md }}>
              <span>Resolve the cause of the failure, then retry; the release continues from the failed step.</span>
              <Button
                componentId="mlflow.datasets.release.retry"
                type="primary"
                disabled={submitting || jobIsActive}
                onClick={() => startJob(false)}
              >
                Retry
              </Button>
            </div>
          }
        />
      )}
      {startError && (
        <Alert
          componentId="mlflow.datasets.release.start_error"
          type="error"
          closable={false}
          message="Unable to start the job"
          description={startError}
        />
      )}
      {!shownJobId && recentJobs.isError && (
        <Alert
          componentId="mlflow.datasets.release.history_error"
          type="error"
          closable={false}
          message="Unable to load active release jobs"
          description={getErrorMessage(recentJobs.error)}
        />
      )}
      {job.isError && (
        <Alert
          componentId="mlflow.datasets.release.status_error"
          type="error"
          closable={false}
          message="Unable to load release status"
          description={`${job.data ? 'The status below may be out of date. ' : ''}${getErrorMessage(job.error)}`}
        />
      )}
      {job.data && <ReleaseJobProgress job={job.data} />}
      <Modal
        componentId="mlflow.datasets.release.confirm"
        visible={confirming}
        title={`Release ${dataset.name} ${version}?`}
        okText="Release"
        cancelText="Cancel"
        onCancel={() => setConfirming(false)}
        onOk={() => {
          setConfirming(false);
          startJob(false);
        }}
      >
        <p>
          The server checks the dataset, then runs <code>dvc add</code>, commits and tags{' '}
          <code>
            {dataset.name}-{version}
          </code>
          , pushes the data and the git branch, and registers the version. A pushed tag is not taken back.
        </p>
        <p>
          Change: <strong>{change.trim()}</strong>
        </p>
      </Modal>
    </section>
  );
};
