/**
 * Run datasets: native training identities, catalog association, then presentation.
 * Naming: get* selects recorded metadata; use* resolves catalog queries.
 */
import { Typography, useDesignSystemTheme } from '@databricks/design-system';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '../../../../common/utils/RoutingUtils';
import { fetchDatasets, fetchDatasetVersions } from '../../../pages/datasets/datasetsApi';
import Routes from '../../../routes';
import type { RunDatasetWithTags } from '../../../types';

// ===== Native training identities =====

interface TrainingDataset {
  name: string;
  version?: string;
  link?: string;
  inputs: RunDatasetWithTags[];
}

const getTrainingDatasets = (datasets: RunDatasetWithTags[]): TrainingDataset[] => {
  const identities = new Map<string, TrainingDataset>();
  for (const input of datasets) {
    const tags = Object.fromEntries(input.tags.map(({ key, value }) => [key, value]));
    if (!['training', 'train', 'validation', 'val', 'trainval'].includes(tags['mlflow.data.context'])) {
      continue;
    }
    const name = tags['dataset_name'] || input.dataset.name;
    const version = tags['version'] || tags['trainval_version'] || tags['data_version'];
    const key = JSON.stringify([name, version]);
    identities.set(key, { name, version, inputs: [...(identities.get(key)?.inputs ?? []), input] });
  }
  return [...identities.values()];
};

// ===== Catalog association =====

/** Resolve only exact catalog identities; historical inputs remain visible without invented links. */
export const useRunTrainingDatasets = (datasets: RunDatasetWithTags[]): TrainingDataset[] => {
  const trainingDatasets = getTrainingDatasets(datasets);
  const catalog = useQuery(['deeplore-datasets'], fetchDatasets, {
    enabled: trainingDatasets.length > 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const catalogNames = new Set(catalog.data?.datasets.map(({ name }) => name));
  const matchedNames = [
    ...new Set(trainingDatasets.filter(({ name }) => catalogNames.has(name)).map(({ name }) => name)),
  ];
  const versions = useQueries({
    queries: matchedNames.map((name) => ({
      queryKey: ['deeplore-dataset-versions', name],
      queryFn: () => fetchDatasetVersions(name),
      refetchOnWindowFocus: false,
      retry: false,
    })),
  });
  return trainingDatasets.map((dataset) => {
    const releasedVersions = versions[matchedNames.indexOf(dataset.name)]?.data;
    const summary = catalog.data?.datasets.find(({ name }) => name === dataset.name);
    const release =
      releasedVersions?.find(({ version }) => version === dataset.version) ??
      (summary?.latest_release?.version === dataset.version ? summary?.latest_release : undefined);
    const contentMatches =
      release &&
      dataset.inputs.every((input) => {
        const tags = Object.fromEntries(input.tags.map(({ key, value }) => [key, value]));
        const split = ['validation', 'val'].includes(tags['mlflow.data.context']) ? 'val' : 'train';
        const expected = release.hashes?.[split]?.toLowerCase();
        const digest = input.dataset.digest.toLowerCase();
        return (
          expected &&
          /^[a-f0-9]{8,32}(?:\.dir)?$/.test(digest) &&
          expected.startsWith(digest) &&
          (!tags['split_md5'] || tags['split_md5'].toLowerCase() === expected)
        );
      });
    return {
      ...dataset,
      link:
        contentMatches && dataset.version
          ? `${Routes.datasetsPageRoute}?${new URLSearchParams({ name: dataset.name, version: dataset.version })}`
          : undefined,
    };
  });
};

// ===== Presentation =====

/** Display the recorded dataset name and version, linking only to an exact catalog match. */
export const RunDatasetEntry = ({ dataset }: { dataset: Pick<TrainingDataset, 'name' | 'version' | 'link'> }) => {
  const label = dataset.version ? `${dataset.name}: ${dataset.version}` : dataset.name;
  return dataset.link ? (
    <Link to={dataset.link} css={{ textAlign: 'left' }}>
      {label}
    </Link>
  ) : (
    <Typography.Text>{label}</Typography.Text>
  );
};

/** Display the training datasets used by the run. */
export const RunViewDatasetBox = ({ datasets }: { datasets: RunDatasetWithTags[] }) => {
  const trainingDatasets = useRunTrainingDatasets(datasets);
  const { theme } = useDesignSystemTheme();
  if (!trainingDatasets.length) {
    return <Typography.Hint>—</Typography.Hint>;
  }
  return (
    <div css={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing.sm, alignItems: 'center' }}>
      {trainingDatasets.map((dataset) => (
        <RunDatasetEntry key={JSON.stringify([dataset.name, dataset.version])} dataset={dataset} />
      ))}
    </div>
  );
};
