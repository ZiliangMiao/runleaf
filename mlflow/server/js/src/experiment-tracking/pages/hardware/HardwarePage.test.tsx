import { renderWithIntl, screen } from '../../../common/utils/TestUtils.react18';
import { QueryClient, QueryClientProvider } from '../../../common/utils/reactQueryHooks';
import { DesignSystemProvider } from '@databricks/design-system';
import HardwarePage from './HardwarePage';
import { fetchHardware, type HardwareSnapshot } from './hardwareApi';

jest.mock('./hardwareApi', () => ({
  fetchHardware: jest.fn(),
}));

const GIB = 1024 ** 3;

const snapshot: HardwareSnapshot = {
  timestamp: 1791968571,
  hostname: 'bld-desktop',
  cpu: { percent: 25, per_cpu: [10, 20, 30, 40], count: 4, load_average: [1.5, 1, 0.5] },
  memory: { total: 256 * GIB, used: 160 * GIB, available: 96 * GIB, percent: 62.5 },
  swap: { total: 64 * GIB, used: 11 * GIB, percent: 17.2 },
  disks: [
    { label: '/', total: 280 * GIB, used: 120 * GIB, free: 160 * GIB, percent: 42.9 },
    { label: '/data', error: 'Permission denied' },
  ],
  gpus: {
    driver_version: '580.126.09',
    cuda_driver_version: '13.0',
    error: null,
    devices: [
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 4090',
        uuid: 'GPU-0',
        bus_id: '00000000:01:00.0',
        utilization: 97,
        memory_used: 40 * GIB,
        memory_total: 48 * GIB,
        temperature: 71,
        power_usage: 336.5,
        power_limit: 450,
        fan_speed: null,
        processes: [
          {
            pid: 1838565,
            username: 'charles',
            command: 'python tools/train.py --train',
            type: 'C',
            gpu_memory: 37 * GIB,
            gpu_sm_utilization: 84,
            cpu_percent: 99.5,
            host_memory: 64 * GIB,
            running_time: '58:32',
          },
        ],
      },
    ],
  },
};

const renderPage = () =>
  renderWithIntl(
    <DesignSystemProvider>
      <QueryClientProvider client={new QueryClient()}>
        <HardwarePage />
      </QueryClientProvider>
    </DesignSystemProvider>,
  );

describe('HardwarePage', () => {
  test('shows GPUs, their processes and the host resources', async () => {
    jest.mocked(fetchHardware).mockResolvedValue(snapshot);
    renderPage();
    expect(await screen.findByText('NVIDIA GeForce RTX 4090')).toBeInTheDocument();
    expect(screen.getByText('40.0 GiB / 48.0 GiB')).toBeInTheDocument();
    expect(screen.getByText('337 / 450 W')).toBeInTheDocument();
    expect(screen.getByText('charles')).toBeInTheDocument();
    expect(screen.getByText('python tools/train.py --train')).toBeInTheDocument();
    expect(screen.getByText('CPU (4 cores)')).toBeInTheDocument();
    expect(screen.getByText('Load average: 1.50 / 1.00 / 0.50')).toBeInTheDocument();
    expect(screen.getByText('160.0 GiB / 256.0 GiB')).toBeInTheDocument();
    expect(screen.getByText(/Permission denied/)).toBeInTheDocument();
    expect(screen.getByText(/Driver 580\.126\.09/)).toBeInTheDocument();
  });

  test('explains when the server cannot see its GPUs', async () => {
    jest.mocked(fetchHardware).mockResolvedValue({
      ...snapshot,
      gpus: { driver_version: null, cuda_driver_version: null, devices: [], error: 'NVML is unavailable' },
    });
    renderPage();
    expect(await screen.findByText('GPUs are not visible to the tracking server')).toBeInTheDocument();
    expect(screen.getByText('NVML is unavailable')).toBeInTheDocument();
  });

  test('shows the server error when the snapshot cannot be read', async () => {
    jest.mocked(fetchHardware).mockRejectedValue(new Error('hardware monitoring needs nvitop'));
    renderPage();
    expect(await screen.findByText('Unable to read the hardware status')).toBeInTheDocument();
    expect(screen.getByText('hardware monitoring needs nvitop')).toBeInTheDocument();
  });
});
