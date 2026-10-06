/**
 * Datasets page: shared presentation, dataset list, changelog, dataset details, then page state.
 * Naming: handle* responds to interactions; fetch* reads the server.
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Header,
  LegacySelect,
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
import { DatasetReleasePanel, getErrorMessage } from './DatasetReleasePanel';
import {
  DATASET_SPLITS,
  fetchDatasets,
  fetchDatasetVersions,
  type DatasetHashes,
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
          {['Dataset', 'Latest version', 'On disk'].map((title) => (
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

// ===== Dataset details =====

const DatasetDetails = ({ dataset, onReleased }: { dataset: DatasetSummary; onReleased: () => void }) => {
  const { theme } = useDesignSystemTheme();
  const [selectedVersion, setSelectedVersion] = useState<string>();
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
  const shownVersion = versionOptions.some((option) => option.value === selectedVersion)
    ? selectedVersion
    : versionOptions[0]?.value;
  const selectedRelease = releasedVersions.find((version) => version.version === shownVersion);
  const metadata = selectedRelease?.metadata ?? (shownVersion === localVersion ? dataset.metadata : undefined);
  // Every field must come from the selected snapshot, including its changelog and hashes.
  const changelog = shownVersion ? metadata?.changelog ?? [] : dataset.changelog ?? [];
  const hashes: DatasetHashes = selectedRelease?.hashes ?? Object.assign({}, ...(metadata?.hashes ?? []));
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
      <Typography.Title level={3} withoutMargins>
        {dataset.name}
      </Typography.Title>
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
            onChange={(version: string) => setSelectedVersion(version)}
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
            {metadata?.root || <Typography.Hint>Not specified</Typography.Hint>}
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
      {dataset.repo && dataset.metadata && (
        <DatasetReleasePanel key={dataset.name} dataset={dataset} onReleased={handleReleased} />
      )}
    </section>
  );
};

// ===== Page =====

/** List the datasets of the configured repositories and release new versions of them. */
const DatasetsPage = () => {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [selectedName, setSelectedName] = useState<string>();
  const datasets = useQuery(['deeplore-datasets'], fetchDatasets, { refetchOnWindowFocus: false, retry: false });
  const refetchDatasets = datasets.refetch;
  const handleReleased = useCallback(() => {
    refetchDatasets();
  }, [refetchDatasets]);
  const listed = datasets.data?.datasets ?? [];
  const selected = listed.find((dataset) => dataset.name === selectedName) ?? listed[0];
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
          <Button
            componentId="mlflow.datasets.refresh"
            disabled={datasets.isFetching || refreshing}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        }
      />
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
                message="No dataset repository is configured"
                description="Set DEEPLORE_DATASET_REPOS on the tracking server to the dataset repository roots."
              />
              <Spacer shrinks={false} />
            </>
          )}
          {listed.length > 0 && (
            <DatasetsTable datasets={listed} selectedName={selected?.name} onSelect={setSelectedName} />
          )}
          {listed.length === 0 && Boolean(datasets.data?.repos.length) && (
            <Typography.Hint>No datasets found in the configured repositories.</Typography.Hint>
          )}
          <Spacer shrinks={false} />
          {selected && <DatasetDetails key={selected.name} dataset={selected} onReleased={handleReleased} />}
          <Spacer shrinks={false} />
        </>
      )}
    </ScrollablePageWrapper>
  );
};

export default DatasetsPage;
