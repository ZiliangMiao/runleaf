import { DeepPartial } from 'redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl, screen } from '@mlflow/mlflow/src/common/utils/TestUtils.react18';
import { DesignSystemProvider } from '@databricks/design-system';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from '../../../../common/utils/RoutingUtils';
import DatasetsPage from '../../../pages/datasets/DatasetsPage';
import { fetchDatasets, fetchDatasetVersions } from '../../../pages/datasets/datasetsApi';
import { RunDatasetWithTags } from '../../../types';
import { RunViewDatasetBox } from './RunViewDatasetBox';
import { RunViewDatasetBoxV2 } from './RunViewDatasetBoxV2';

jest.mock('../../../pages/datasets/datasetsApi', () => ({
  DATASET_SPLITS: ['train', 'val', 'test'],
  fetchDatasets: jest.fn(),
  fetchDatasetVersions: jest.fn(),
}));

jest.mock('../../../pages/datasets/DatasetReleasePanel', () => ({
  DatasetReleasePanel: () => null,
  getErrorMessage: String,
}));

const trainingInput = (name: string, version: string, context = 'training'): DeepPartial<RunDatasetWithTags> => ({
  dataset: { name, digest: '12345678' },
  tags: [
    { key: 'mlflow.data.context', value: context },
    { key: 'version', value: version },
  ],
});

describe.each([
  ['classic', RunViewDatasetBox],
  ['unified', RunViewDatasetBoxV2],
])('RunViewDatasetBox (%s)', (_, Component) => {
  beforeEach(() => {
    jest.mocked(fetchDatasets).mockResolvedValue({
      repos: [],
      datasets: [
        {
          name: 'dataset_train',
          repo: null,
          status: 'released',
          units: {},
          metadata: null,
          next_versions: [],
          unfinished_version: null,
          error: null,
          latest_release: null,
        },
      ],
    });
    jest.mocked(fetchDatasetVersions).mockResolvedValue([
      {
        name: 'dataset_train',
        version: 'v1.0.0',
        hashes: { train: '1234567890abcdef1234567890abcdef', val: '1234567890abcdef1234567890abcdef' },
      },
    ] as any);
  });

  const renderComponent = (
    datasets: DeepPartial<RunDatasetWithTags>[] = [],
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  ) =>
    renderWithIntl(
      <DesignSystemProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Routes>
              <Route path="/" element={<Component datasets={datasets as RunDatasetWithTags[]} />} />
              <Route path="/datasets" element={<DatasetsPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </DesignSystemProvider>,
    );

  test('links a native training input to its exact catalog version', async () => {
    renderComponent([trainingInput('dataset_train', 'v1.0.0')]);
    const link = await screen.findByRole('link', { name: 'dataset_train: v1.0.0' });
    expect(link).toHaveAttribute('href', '/datasets?name=dataset_train&version=v1.0.0');
  });

  test('opens the recorded release instead of the newest catalog version', async () => {
    jest.mocked(fetchDatasetVersions).mockResolvedValue([
      {
        name: 'dataset_train',
        version: 'v2.0.0',
        hashes: { train: '1234567890abcdef1234567890abcdef' },
        metadata: { source: 'newest-source' },
      },
      {
        name: 'dataset_train',
        version: 'v1.0.0',
        hashes: { train: '1234567890abcdef1234567890abcdef' },
        metadata: { source: 'recorded-source' },
      },
    ] as any);
    renderComponent([trainingInput('dataset_train', 'v1.0.0')]);
    await userEvent.click(await screen.findByRole('link', { name: 'dataset_train: v1.0.0' }));
    expect(await screen.findByText('recorded-source')).toBeInTheDocument();
    expect(screen.queryByText('newest-source')).not.toBeInTheDocument();
  });

  test('deduplicates training and validation inputs while excluding evaluation inputs', async () => {
    renderComponent([
      trainingInput('dataset_train', 'v1.0.0'),
      trainingInput('dataset_train', 'v1.0.0', 'validation'),
      trainingInput('dataset_eval', 'v2.0.0', 'evaluation'),
      trainingInput('dataset_test', 'v2.0.0', 'testing'),
    ]);
    expect(await screen.findAllByRole('link')).toHaveLength(1);
    expect(screen.queryByText(/dataset_eval|dataset_test/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+1' })).not.toBeInTheDocument();
  });

  test('retains historical versions without linking to an unrelated catalog release', async () => {
    renderComponent([trainingInput('dataset_train', 'mix-historical')]);
    expect(await screen.findByText('dataset_train: mix-historical')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('uses an explicitly associated dataset name from the native input', async () => {
    const input = trainingInput('legacy/path', 'v1.0.0');
    input.tags?.push({ key: 'dataset_name', value: 'dataset_train' });
    renderComponent([input]);
    expect(await screen.findByRole('link', { name: 'dataset_train: v1.0.0' })).toBeInTheDocument();
  });

  test.each(['digest', 'split_md5', 'validation'])('does not link conflicting %s content', async (conflict) => {
    const training = trainingInput('dataset_train', 'v1.0.0');
    const validation = trainingInput('dataset_train', 'v1.0.0', 'validation');
    if (conflict === 'digest') {
      training.dataset = { ...training.dataset, digest: 'ffffffff' };
    } else if (conflict === 'split_md5') {
      training.tags?.push({ key: 'split_md5', value: '1234567890abcdef1234567890abcdee' });
    } else {
      validation.dataset = { ...validation.dataset, digest: 'ffffffff' };
    }
    const queryClient = new QueryClient();
    queryClient.setQueryData(['deeplore-datasets'], await fetchDatasets());
    queryClient.setQueryData(
      ['deeplore-dataset-versions', 'dataset_train'],
      await fetchDatasetVersions('dataset_train'),
    );
    renderComponent([training, validation], queryClient);
    expect(screen.getByText('dataset_train: v1.0.0')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('shows an empty value when all inputs belong to evaluations', () => {
    renderComponent([trainingInput('dataset_eval', 'v1.0.0', 'evaluation')]);
    expect(screen.queryByText(/dataset_eval/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('shows every training dataset and version without an expansion button', async () => {
    renderComponent([
      trainingInput('dataset_train', 'v1.0.0'),
      trainingInput('dataset_train', 'v2.0.0'),
      trainingInput('dataset_validation', 'v3.0.0', 'validation'),
    ]);
    expect(await screen.findByRole('link', { name: 'dataset_train: v1.0.0' })).toBeInTheDocument();
    expect(screen.getByText('dataset_train: v2.0.0')).toBeVisible();
    expect(screen.getByText('dataset_validation: v3.0.0')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
