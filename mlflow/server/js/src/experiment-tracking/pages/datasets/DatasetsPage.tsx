/**
 * Datasets page: shared presentation, dataset list, changelog, dataset creation, dataset
 * lifecycle, dataset details, then page state.
 * Naming: handle* responds to interactions; fetch* reads the server.
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Header,
  Input,
  LegacySelect,
  Modal,
  Spacer,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tag,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { ScrollablePageWrapper } from '../../../common/components/ScrollablePageWrapper';
import { useSearchParams } from '../../../common/utils/RoutingUtils';
import { DatasetReleasePanel, getErrorMessage } from './DatasetReleasePanel';
import {
  DATASET_SPLITS,
  archiveDataset,
  createDataset,
  deleteDataset,
  fetchDatasets,
  fetchDatasetsWithArchived,
  fetchDatasetVersions,
  getDatasetHashes,
  unarchiveDataset,
  type DatasetHashes,
  type DatasetStatus,
  type DatasetSummary,
} from './datasetsApi';

// ===== Shared presentation =====

/** The design-system table fills its parent's height; a block parent lets it size to its rows. */
const TableBlock = ({ children }: { children: React.ReactNode }) => (
  <div css={{ minWidth: 0, overflowX: 'auto' }}>{children}</div>
);

const MetadataField = ({ label, children }: { label: string; children: React.ReactNode }) => {
  const { theme } = useDesignSystemTheme();
  return (
    <div css={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing.sm }}>
      <span css={{ width: 120, flexShrink: 0, color: theme.colors.textSecondary }}>{label}</span>
      <div css={{ flex: '1 1 180px', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
};

// ===== Dataset list =====

const STATUS_COLORS: Record<DatasetStatus, 'lime' | 'default' | 'charcoal'> = {
  released: 'lime',
  unreleased: 'default',
  archived: 'charcoal',
};

const DatasetsTable = ({
  datasets,
  selectedName,
  onSelect,
}: {
  datasets: DatasetSummary[];
  selectedName?: string;
  onSelect: (name: string) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  return (
    <TableBlock>
      <Table aria-label="Datasets" css={{ minWidth: 480 }}>
        <TableRow isHeader>
          {['Dataset', 'Status', 'Latest version', 'On disk'].map((title) => (
            <TableHeader componentId="mlflow.datasets.list.header" key={title}>
              {title}
            </TableHeader>
          ))}
        </TableRow>
        {datasets.map((dataset) => {
          return (
            <TableRow
              key={dataset.name}
              onClick={() => onSelect(dataset.name)}
              css={{
                cursor: 'pointer',
                background: dataset.name === selectedName ? theme.colors.actionDefaultBackgroundHover : undefined,
              }}
            >
              <TableCell>
                <Button
                  componentId="mlflow.datasets.list.name"
                  type="link"
                  aria-pressed={dataset.name === selectedName}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(dataset.name);
                  }}
                  css={{ padding: 0, height: 'auto', fontWeight: dataset.name === selectedName ? 600 : 400 }}
                >
                  {dataset.name}
                </Button>
              </TableCell>
              <TableCell>
                <Tag
                  componentId="mlflow.datasets.list.status"
                  color={STATUS_COLORS[dataset.status]}
                  css={{ margin: 0 }}
                >
                  {dataset.status}
                </Tag>
              </TableCell>
              <TableCell>
                {dataset.latest_release?.version ?? dataset.metadata?.version ?? (
                  <Typography.Hint>{dataset.metadata ? 'Not versioned' : 'Unavailable'}</Typography.Hint>
                )}
              </TableCell>
              <TableCell multiline wrapContent={false}>
                <div css={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing.xs }}>
                  {Object.keys(dataset.units).length ? (
                    Object.entries(dataset.units).map(([unit, exists]) => (
                      <Tag
                        key={unit}
                        componentId="mlflow.datasets.list.unit"
                        color={exists ? 'lime' : 'default'}
                        title={exists ? 'Directory exists and will be released' : 'Directory is missing'}
                        css={{ margin: 0 }}
                      >
                        {unit}
                      </Tag>
                    ))
                  ) : (
                    <Typography.Hint>Unavailable</Typography.Hint>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
    </TableBlock>
  );
};

// ===== Changelog =====

const DatasetChangelogTable = ({ changelog }: { changelog: Record<string, string>[] }) => (
  <TableBlock>
    <Table aria-label="Dataset changelog" css={{ minWidth: 360 }}>
      <TableRow isHeader>
        <TableHeader componentId="mlflow.datasets.changelog.version" css={{ flex: '0 0 110px' }}>
          Version
        </TableHeader>
        <TableHeader componentId="mlflow.datasets.changelog.change">Change</TableHeader>
      </TableRow>
      {changelog.flatMap((entry) =>
        Object.entries(entry).map(([version, change]) => (
          <TableRow key={version}>
            <TableCell css={{ flex: '0 0 110px' }}>{version}</TableCell>
            <TableCell multiline css={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {change}
            </TableCell>
          </TableRow>
        )),
      )}
    </Table>
  </TableBlock>
);

// ===== Dataset creation =====

/** Register a dataset and write its metadata.yaml template; data is prepared afterwards. */
const DatasetCreateModal = ({
  repos,
  onClose,
  onCreated,
}: {
  repos: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [metrics, setMetrics] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const nameIsValid = /^[a-z][a-z0-9-]*$/.test(name);
  const handleCreate = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const metricNames = metrics
        .split(',')
        .map((metric) => metric.trim())
        .filter(Boolean);
      await createDataset(repo.trim(), name, source.trim(), metricNames);
      onCreated(name);
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  };
  const fieldStyles = { display: 'block', marginBottom: 4, marginTop: theme.spacing.md };
  return (
    <Modal
      componentId="mlflow.datasets.create"
      visible
      title="Create dataset"
      okText="Create"
      cancelText="Cancel"
      okButtonProps={{ disabled: submitting || !repo.trim() || !nameIsValid || !source.trim() }}
      onCancel={onClose}
      onOk={handleCreate}
    >
      <Typography.Hint>
        The dataset directory is fixed to data/&lt;name&gt; inside the repository. Creating registers the name and
        writes a metadata.yaml template; nothing is committed until the first release.
      </Typography.Hint>
      <label htmlFor="dataset-create-repo" css={fieldStyles}>
        Git repository
      </label>
      <AutoComplete
        value={repo}
        onChange={(value: string) => setRepo(value)}
        options={repos.map((path) => ({ value: path, label: path }))}
        filterOption={(input, option) =>
          String(option?.value ?? '')
            .toLowerCase()
            .includes(input.toLowerCase())
        }
        css={{ width: '100%' }}
      >
        <Input
          id="dataset-create-repo"
          componentId="mlflow.datasets.create.repo"
          aria-label="Git repository"
          aria-describedby="dataset-create-repo-hint"
          placeholder="Select or enter an absolute repository path"
        />
      </AutoComplete>
      <Typography.Hint id="dataset-create-repo-hint">
        Enter an existing Git repository on the MLflow server. The directory must be accessible to the server.
      </Typography.Hint>
      <label htmlFor="dataset-create-name" css={fieldStyles}>
        Name
      </label>
      <Input
        id="dataset-create-name"
        componentId="mlflow.datasets.create.name"
        aria-label="Name"
        placeholder="Lowercase letters, digits and hyphens, starting with a letter"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor="dataset-create-source" css={fieldStyles}>
        Source
      </label>
      <Input
        id="dataset-create-source"
        componentId="mlflow.datasets.create.source"
        aria-label="Source"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      <label htmlFor="dataset-create-metrics" css={fieldStyles}>
        Metrics
      </label>
      <Input
        id="dataset-create-metrics"
        componentId="mlflow.datasets.create.metrics"
        aria-label="Metrics"
        placeholder="Comma-separated; leave empty for a dataset without a test split"
        value={metrics}
        onChange={(event) => setMetrics(event.target.value)}
      />
      {error && (
        <Alert
          componentId="mlflow.datasets.create.error"
          type="error"
          closable={false}
          message="Unable to create the dataset"
          description={error}
          css={{ marginTop: theme.spacing.md }}
        />
      )}
    </Modal>
  );
};

// ===== Dataset lifecycle =====

const LIFECYCLE_ACTIONS = {
  delete: {
    label: 'Delete',
    confirm:
      'removes its directory and its registration. The dataset was never released, so nothing else refers to it.',
    run: deleteDataset,
  },
  archive: {
    label: 'Archive',
    confirm:
      'removes data/<name> from the repository with one pushed commit and hides the dataset. Released versions, ' +
      'git tags and DVC data are kept, and archiving can be undone.',
    run: archiveDataset,
  },
  unarchive: {
    label: 'Unarchive',
    confirm: 'restores data/<name> from the latest release with one pushed commit and lists the dataset again.',
    run: unarchiveDataset,
  },
} as const;

/** Delete a never-released dataset, or archive and unarchive a released one. */
const DatasetLifecycleButton = ({ dataset, onChanged }: { dataset: DatasetSummary; onChanged: () => void }) => {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const action =
    LIFECYCLE_ACTIONS[
      dataset.status === 'archived' ? 'unarchive' : dataset.status === 'released' ? 'archive' : 'delete'
    ];
  const handleConfirmed = async () => {
    setConfirming(false);
    setRunning(true);
    setError(undefined);
    try {
      await action.run(dataset.name);
      onChanged();
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <Button
        componentId="mlflow.datasets.lifecycle"
        danger={action.label !== 'Unarchive'}
        loading={running}
        disabled={running}
        onClick={() => setConfirming(true)}
      >
        {action.label}
      </Button>
      {error && (
        <Alert
          componentId="mlflow.datasets.lifecycle.error"
          type="error"
          closable={false}
          message={`${action.label} failed`}
          description={<span css={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</span>}
        />
      )}
      <Modal
        componentId="mlflow.datasets.lifecycle.confirm"
        visible={confirming}
        title={`${action.label} ${dataset.name}?`}
        okText={action.label}
        cancelText="Cancel"
        onCancel={() => setConfirming(false)}
        onOk={handleConfirmed}
      >
        <p>
          {action.label} {action.confirm.replace('<name>', dataset.name)}
        </p>
      </Modal>
    </>
  );
};

// ===== Dataset details =====

const DatasetDetails = ({
  dataset,
  selectedVersion,
  onVersionSelected,
  onReleased,
}: {
  dataset: DatasetSummary;
  selectedVersion?: string;
  onVersionSelected: (version: string) => void;
  onReleased: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const versions = useQuery(['deeplore-dataset-versions', dataset.name], () => fetchDatasetVersions(dataset.name), {
    refetchOnWindowFocus: false,
    retry: false,
  });
  const refetchVersions = versions.refetch;
  const handleReleased = useCallback(() => {
    refetchVersions();
    onReleased();
  }, [refetchVersions, onReleased]);

  const releasedVersions = [
    ...(dataset.latest_release ? [dataset.latest_release] : []),
    ...(versions.data ?? []).filter((version) => version.version !== dataset.latest_release?.version),
  ];
  const localVersion = dataset.metadata?.version ?? 'unversioned';
  const versionOptions = [
    ...releasedVersions.map((version) => ({ value: version.version, label: version.version })),
    ...(dataset.metadata && !releasedVersions.some((version) => version.version === localVersion)
      ? [{ value: localVersion, label: dataset.metadata.version ?? 'Unversioned' }]
      : []),
  ];
  const shownVersion = selectedVersion ?? versionOptions[0]?.value;
  const selectedRelease = releasedVersions.find((version) => version.version === shownVersion);
  const metadata = selectedRelease?.metadata ?? (shownVersion === localVersion ? dataset.metadata : undefined);
  // Every field must come from the selected snapshot, including its changelog and hashes.
  const changelog = shownVersion ? metadata?.changelog ?? [] : dataset.changelog ?? [];
  const hashes: DatasetHashes = selectedRelease?.hashes ?? getDatasetHashes(metadata);
  const changeCount = changelog.reduce((count, entry) => count + Object.keys(entry).length, 0);
  const metadataStyles = {
    border: `1px solid ${theme.colors.border}`,
    borderRadius: theme.borders.borderRadiusMd,
    padding: theme.spacing.md,
  };

  return (
    <section
      aria-label={`Dataset ${dataset.name}`}
      css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md, minWidth: 0 }}
    >
      <div css={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.md }}>
        <Typography.Title level={3} withoutMargins>
          {dataset.name}
        </Typography.Title>
        <DatasetLifecycleButton dataset={dataset} onChanged={handleReleased} />
      </div>
      {dataset.error && (
        <Alert componentId="mlflow.datasets.details.error" type="warning" closable={false} message={dataset.error} />
      )}
      <section aria-label="Dataset metadata" css={metadataStyles}>
        <div
          css={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: theme.spacing.md,
            marginBottom: theme.spacing.sm,
          }}
        >
          <Typography.Title level={4} withoutMargins>
            Metadata
          </Typography.Title>
          <LegacySelect
            aria-label="Metadata version"
            value={shownVersion}
            options={versionOptions}
            onChange={(version: string) => onVersionSelected(version)}
            loading={versions.isFetching}
            disabled={versionOptions.length === 0}
            placeholder="No version available"
            css={{ width: 180, maxWidth: '100%' }}
          />
        </div>
        <Typography.Hint css={{ display: 'block', marginBottom: theme.spacing.md }}>
          Read-only. Edit the local metadata.yaml file, then publish a new version through MLflow.
        </Typography.Hint>
        {versions.error && (
          <Alert
            componentId="mlflow.datasets.metadata.versions_error"
            type="error"
            closable={false}
            message="Unable to load metadata versions"
            description={getErrorMessage(versions.error)}
            css={{ marginBottom: theme.spacing.md }}
          />
        )}
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <MetadataField label="Source">
            {metadata?.source || <Typography.Hint>Not specified</Typography.Hint>}
          </MetadataField>
          <MetadataField label="Directory">
            {dataset.repo ? (
              `${dataset.repo}/data/${dataset.name}`
            ) : (
              <Typography.Hint>Repository is unavailable</Typography.Hint>
            )}
          </MetadataField>
          <MetadataField label="Released by">
            {selectedRelease?.released_by || <Typography.Hint>Not recorded</Typography.Hint>}
          </MetadataField>
          <MetadataField label="Git commit">
            {selectedRelease?.git_commit ? (
              <code>{selectedRelease.git_commit}</code>
            ) : (
              <Typography.Hint>Not available</Typography.Hint>
            )}
          </MetadataField>
          <MetadataField label="Git tag">
            {selectedRelease?.git_tag ? (
              <code>{selectedRelease.git_tag}</code>
            ) : (
              <Typography.Hint>Not available</Typography.Hint>
            )}
          </MetadataField>
          <MetadataField label="Metrics">
            <div css={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing.xs }}>
              {metadata?.metrics?.length ? (
                metadata.metrics.map((metric) => (
                  <Tag key={metric} componentId="mlflow.datasets.details.metric" color="default" css={{ margin: 0 }}>
                    {metric}
                  </Tag>
                ))
              ) : (
                <Typography.Hint>None configured</Typography.Hint>
              )}
            </div>
          </MetadataField>
          <MetadataField label="Hashes">
            <div aria-label="Dataset hashes" css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
              {DATASET_SPLITS.map((split) => (
                <div key={split} css={{ display: 'flex', gap: theme.spacing.sm }}>
                  <span css={{ width: 48, flexShrink: 0 }}>{split}</span>
                  <code css={{ minWidth: 0 }}>{hashes[split] ?? 'null'}</code>
                </div>
              ))}
            </div>
          </MetadataField>
          <MetadataField label="Changelog">
            <details>
              <summary css={{ cursor: 'pointer' }} aria-label="Expand changelog">
                {changeCount} {changeCount === 1 ? 'entry' : 'entries'}
              </summary>
              <div css={{ paddingTop: theme.spacing.sm }}>
                {changeCount > 0 ? (
                  <DatasetChangelogTable changelog={changelog} />
                ) : (
                  <Typography.Hint>No changes recorded yet.</Typography.Hint>
                )}
              </div>
            </details>
          </MetadataField>
        </div>
      </section>
      {dataset.repo && dataset.metadata && dataset.status !== 'archived' && (
        <DatasetReleasePanel key={dataset.name} dataset={dataset} onReleased={handleReleased} />
      )}
    </section>
  );
};

// ===== Page =====

/** List the datasets of known repositories and release new versions of them. */
const DatasetsPage = () => {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedName = searchParams.get('name');
  const selectedVersion = searchParams.get('version') ?? undefined;
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  // The default listing shares its cache entry with the run page's dataset links.
  const datasets = useQuery(
    showArchived ? ['deeplore-datasets', 'with-archived'] : ['deeplore-datasets'],
    showArchived ? fetchDatasetsWithArchived : fetchDatasets,
    { refetchOnWindowFocus: false, retry: false },
  );
  const refetchDatasets = datasets.refetch;
  const handleReleased = useCallback(() => {
    refetchDatasets();
  }, [refetchDatasets]);
  const listed = datasets.data?.datasets ?? [];
  const selected = selectedName ? listed.find((dataset) => dataset.name === selectedName) : listed[0];
  const handleSelected = (name: string, version?: string) => {
    setSearchParams({ name, ...(version ? { version } : {}) });
  };
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        datasets.refetch(),
        queryClient.invalidateQueries(['deeplore-dataset-versions']),
        queryClient.invalidateQueries(['deeplore-dataset-releases']),
        queryClient.invalidateQueries(['deeplore-dataset-release']),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ScrollablePageWrapper>
      <Spacer shrinks={false} />
      <Header
        title="Datasets"
        buttons={
          <>
            <Checkbox
              componentId="mlflow.datasets.show_archived"
              isChecked={showArchived}
              onChange={(checked) => setShowArchived(Boolean(checked))}
            >
              Show archived
            </Checkbox>
            <Button
              componentId="mlflow.datasets.create.open"
              type="primary"
              disabled={datasets.isLoading || Boolean(datasets.error)}
              onClick={() => setCreating(true)}
            >
              Create dataset
            </Button>
            <Button
              componentId="mlflow.datasets.refresh"
              disabled={datasets.isFetching || refreshing}
              onClick={handleRefresh}
            >
              Refresh
            </Button>
          </>
        }
      />
      {creating && (
        <DatasetCreateModal
          repos={datasets.data?.repos ?? []}
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            refetchDatasets();
            handleSelected(name);
          }}
        />
      )}
      <Spacer shrinks={false} />
      {datasets.error ? (
        <Alert
          componentId="mlflow.datasets.error"
          type="error"
          closable={false}
          message="Unable to load datasets"
          description={getErrorMessage(datasets.error)}
        />
      ) : datasets.isLoading ? (
        <div role="status">
          <Spinner size="small" /> Loading datasets...
        </div>
      ) : (
        <>
          {datasets.data?.repos.length === 0 && (
            <>
              <Alert
                componentId="mlflow.datasets.no_repos"
                type="info"
                closable={false}
                message="No dataset repositories yet"
                description="Create a dataset and enter the path of an existing Git repository on the MLflow server."
              />
              <Spacer shrinks={false} />
            </>
          )}
          {listed.length > 0 && (
            <DatasetsTable datasets={listed} selectedName={selected?.name} onSelect={handleSelected} />
          )}
          {listed.length === 0 && Boolean(datasets.data?.repos.length) && (
            <Typography.Hint>No datasets found in the known repositories.</Typography.Hint>
          )}
          <Spacer shrinks={false} />
          {selected && (
            <DatasetDetails
              key={selected.name}
              dataset={selected}
              selectedVersion={selectedVersion}
              onVersionSelected={(version) => handleSelected(selected.name, version)}
              onReleased={handleReleased}
            />
          )}
          <Spacer shrinks={false} />
        </>
      )}
    </ScrollablePageWrapper>
  );
};

export default DatasetsPage;
