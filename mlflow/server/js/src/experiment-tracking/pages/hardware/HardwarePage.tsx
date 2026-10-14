/**
 * Hardware page: formatting, shared presentation, GPU panels, host panels, then page state.
 * The tracking server samples its host through nvitop; the page polls it every second.
 * Naming: format* produces labels; handle* responds to interactions.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Header,
  Spacer,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { ScrollablePageWrapper } from '../../../common/components/ScrollablePageWrapper';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import { fetchHardware, type DiskUsage, type GpuDevice, type HardwareSnapshot } from './hardwareApi';

const REFRESH_INTERVAL_MS = 1000;

// ===== Formatting =====

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const formatBytes = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined
    ? '-'
    : bytes >= GIB
    ? `${(bytes / GIB).toFixed(1)} GiB`
    : `${Math.round(bytes / MIB)} MiB`;

const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : `${Math.round(value)}%`;

const formatRatio = (used: number | null | undefined, total: number | null | undefined) =>
  used === null || used === undefined || !total ? undefined : (used / total) * 100;

const getErrorMessage = (error: unknown) =>
  error instanceof ErrorWrapper ? error.getMessageField() : error instanceof Error ? error.message : String(error);

// ===== Shared presentation =====

/** A horizontal gauge colored like nvitop: green, then yellow from 60%, then red from 85%. */
const UsageBar = ({ percent, label }: { percent?: number | null; label: string }) => {
  const { theme } = useDesignSystemTheme();
  const value = percent === null || percent === undefined ? 0 : Math.min(Math.max(percent, 0), 100);
  const color =
    value >= 85
      ? theme.colors.textValidationDanger
      : value >= 60
      ? theme.colors.textValidationWarning
      : theme.colors.textValidationSuccess;
  return (
    <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm, width: '100%', minWidth: 0 }}>
      <div
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        css={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          backgroundColor: theme.colors.backgroundSecondary,
          border: `1px solid ${theme.colors.border}`,
        }}
      >
        <div css={{ width: `${value}%`, height: '100%', backgroundColor: color, transition: 'width 0.2s' }} />
      </div>
      <span css={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
};

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => {
  const { theme } = useDesignSystemTheme();
  return (
    <section
      css={{
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
        padding: theme.spacing.md,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.sm,
      }}
    >
      <Typography.Title level={4} css={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {children}
    </section>
  );
};

/** The design-system table fills its parent's height; a block parent lets it size to its rows. */
const TableBlock = ({ children }: { children: React.ReactNode }) => (
  <div css={{ minWidth: 0, overflowX: 'auto' }}>{children}</div>
);

// ===== GPU panels =====

const GpuTable = ({ devices }: { devices: GpuDevice[] }) => (
  <TableBlock>
    <Table aria-label="GPUs" css={{ minWidth: 900 }}>
      <TableRow isHeader>
        <TableHeader componentId="mlflow.hardware.gpus.index" css={{ flex: '0 0 48px' }}>
          GPU
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.name" css={{ flex: '1 1 160px' }}>
          Name
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.utilization" css={{ flex: '1 1 160px' }}>
          Utilization
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.memory" css={{ flex: '2 1 240px' }}>
          Memory
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.temperature" css={{ flex: '0 0 72px' }}>
          Temp
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.power" css={{ flex: '0 0 120px' }}>
          Power
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.fan" css={{ flex: '0 0 56px' }}>
          Fan
        </TableHeader>
        <TableHeader componentId="mlflow.hardware.gpus.processes" css={{ flex: '0 0 88px' }}>
          Processes
        </TableHeader>
      </TableRow>
      {devices.map((device) => (
        <TableRow key={device.index}>
          <TableCell css={{ flex: '0 0 48px' }}>{device.index}</TableCell>
          <TableCell css={{ flex: '1 1 160px' }} title={device.bus_id ?? undefined}>
            {device.name ?? '-'}
          </TableCell>
          <TableCell css={{ flex: '1 1 160px' }}>
            <UsageBar percent={device.utilization} label={formatPercent(device.utilization)} />
          </TableCell>
          <TableCell css={{ flex: '2 1 240px' }}>
            <UsageBar
              percent={formatRatio(device.memory_used, device.memory_total)}
              label={`${formatBytes(device.memory_used)} / ${formatBytes(device.memory_total)}`}
            />
          </TableCell>
          <TableCell css={{ flex: '0 0 72px' }}>
            {device.temperature === null ? '-' : `${device.temperature}°C`}
          </TableCell>
          <TableCell css={{ flex: '0 0 120px' }}>
            {device.power_usage === null
              ? '-'
              : `${Math.round(device.power_usage)} / ${
                  device.power_limit === null ? '-' : Math.round(device.power_limit)
                } W`}
          </TableCell>
          <TableCell css={{ flex: '0 0 56px' }}>{formatPercent(device.fan_speed)}</TableCell>
          <TableCell css={{ flex: '0 0 88px' }}>{device.processes.length}</TableCell>
        </TableRow>
      ))}
    </Table>
  </TableBlock>
);

// `gpuProcess`, not `process`: a local `process` would shadow the global the css prop compiles to.
const GpuProcessTable = ({ devices }: { devices: GpuDevice[] }) => {
  const rows = devices.flatMap((device) =>
    [...device.processes]
      .sort((left, right) => (right.gpu_memory ?? 0) - (left.gpu_memory ?? 0))
      .map((gpuProcess) => ({ device: device.index, gpuProcess })),
  );
  if (!rows.length) {
    return <Typography.Hint>No GPU processes are running.</Typography.Hint>;
  }
  return (
    <TableBlock>
      <Table aria-label="GPU processes" css={{ minWidth: 900 }}>
        <TableRow isHeader>
          {[
            ['GPU', '0 0 48px'],
            ['PID', '0 0 88px'],
            ['User', '0 0 104px'],
            ['GPU memory', '0 0 104px'],
            ['SM', '0 0 56px'],
            ['CPU', '0 0 64px'],
            ['Host memory', '0 0 104px'],
            ['Time', '0 0 96px'],
            ['Command', '1 1 240px'],
          ].map(([title, flex]) => (
            <TableHeader componentId="mlflow.hardware.processes.header" key={title} css={{ flex }}>
              {title}
            </TableHeader>
          ))}
        </TableRow>
        {rows.map(({ device, gpuProcess }) => (
          <TableRow key={`${device}-${gpuProcess.pid}`}>
            <TableCell css={{ flex: '0 0 48px' }}>{device}</TableCell>
            <TableCell css={{ flex: '0 0 88px' }}>{gpuProcess.pid}</TableCell>
            <TableCell css={{ flex: '0 0 104px' }}>{gpuProcess.username ?? '-'}</TableCell>
            <TableCell css={{ flex: '0 0 104px' }}>{formatBytes(gpuProcess.gpu_memory)}</TableCell>
            <TableCell css={{ flex: '0 0 56px' }}>{formatPercent(gpuProcess.gpu_sm_utilization)}</TableCell>
            <TableCell css={{ flex: '0 0 64px' }}>{formatPercent(gpuProcess.cpu_percent)}</TableCell>
            <TableCell css={{ flex: '0 0 104px' }}>{formatBytes(gpuProcess.host_memory)}</TableCell>
            <TableCell css={{ flex: '0 0 96px' }}>{gpuProcess.running_time ?? '-'}</TableCell>
            <TableCell css={{ flex: '1 1 240px' }} title={gpuProcess.command ?? undefined}>
              <span css={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {gpuProcess.command ?? '-'}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </Table>
    </TableBlock>
  );
};

// ===== Host panels =====

/** One thin column per core, filled to its utilization. */
const CoreGrid = ({ percents }: { percents: number[] }) => {
  const { theme } = useDesignSystemTheme();
  return (
    <div css={{ display: 'flex', flexWrap: 'wrap', gap: 2 }} aria-label="Per-core utilization">
      {percents.map((percent, index) => (
        <div
          key={index}
          title={`CPU ${index}: ${Math.round(percent)}%`}
          css={{
            width: 8,
            height: 24,
            display: 'flex',
            alignItems: 'flex-end',
            backgroundColor: theme.colors.backgroundSecondary,
            border: `1px solid ${theme.colors.border}`,
          }}
        >
          <div
            css={{
              width: '100%',
              height: `${Math.min(percent, 100)}%`,
              backgroundColor:
                percent >= 85
                  ? theme.colors.textValidationDanger
                  : percent >= 60
                  ? theme.colors.textValidationWarning
                  : theme.colors.textValidationSuccess,
            }}
          />
        </div>
      ))}
    </div>
  );
};

const CpuPanel = ({ cpu }: { cpu: HardwareSnapshot['cpu'] }) => (
  <Panel title={`CPU (${cpu.count ?? cpu.per_cpu.length} cores)`}>
    <UsageBar percent={cpu.percent} label={formatPercent(cpu.percent)} />
    <Typography.Text color="secondary">
      Load average: {cpu.load_average.map((load) => load.toFixed(2)).join(' / ') || '-'}
    </Typography.Text>
    <CoreGrid percents={cpu.per_cpu} />
  </Panel>
);

const MemoryPanel = ({ memory, swap }: Pick<HardwareSnapshot, 'memory' | 'swap'>) => (
  <Panel title="Memory">
    <Typography.Text color="secondary">RAM</Typography.Text>
    <UsageBar percent={memory.percent} label={`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`} />
    <Typography.Text color="secondary">Swap</Typography.Text>
    <UsageBar percent={swap.percent} label={`${formatBytes(swap.used)} / ${formatBytes(swap.total)}`} />
  </Panel>
);

const DiskPanel = ({ disks }: { disks: DiskUsage[] }) => (
  <Panel title="Disks">
    {disks.map((disk) => (
      <div key={disk.label}>
        <Typography.Text color="secondary">{disk.label}</Typography.Text>
        {disk.error ? (
          <Typography.Text color="error"> {disk.error}</Typography.Text>
        ) : (
          <UsageBar
            percent={disk.percent}
            label={`${formatBytes(disk.used)} / ${formatBytes(disk.total)} (${formatBytes(disk.free)} free)`}
          />
        )}
      </div>
    ))}
  </Panel>
);

// ===== Page state =====

const HardwarePage = () => {
  const { theme } = useDesignSystemTheme();
  const [paused, setPaused] = useState(false);
  const hardware = useQuery(['deeplore-hardware'], fetchHardware, {
    refetchInterval: paused ? false : REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: false,
    keepPreviousData: true,
    retry: false,
  });
  const snapshot = hardware.data;
  const gpus = snapshot?.gpus;
  return (
    <ScrollablePageWrapper>
      <Spacer shrinks={false} />
      <Header
        title="Hardware"
        buttons={
          <Button componentId="mlflow.hardware.pause" onClick={() => setPaused((value) => !value)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
        }
      />
      {snapshot && (
        <Typography.Text color="secondary">
          {snapshot.hostname}
          {gpus?.driver_version && ` · Driver ${gpus.driver_version}`}
          {gpus?.cuda_driver_version && ` · CUDA ${gpus.cuda_driver_version}`}
          {` · Updated ${new Date(snapshot.timestamp * 1000).toLocaleTimeString()}`}
          {paused && ' · Paused'}
        </Typography.Text>
      )}
      <Spacer />
      {hardware.error && (
        <Alert
          componentId="mlflow.hardware.error"
          type="error"
          closable={false}
          message="Unable to read the hardware status"
          description={getErrorMessage(hardware.error)}
          css={{ marginBottom: theme.spacing.md }}
        />
      )}
      {!snapshot && hardware.isLoading && <Spinner />}
      {snapshot && (
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.lg, paddingBottom: theme.spacing.lg }}>
          <Panel title={`GPUs (${gpus?.devices.length ?? 0})`}>
            {gpus?.error ? (
              <Alert
                componentId="mlflow.hardware.gpus.error"
                type="warning"
                closable={false}
                message="GPUs are not visible to the tracking server"
                description={gpus.error}
              />
            ) : (
              <>
                <GpuTable devices={gpus?.devices ?? []} />
                <Typography.Text bold>Processes</Typography.Text>
                <GpuProcessTable devices={gpus?.devices ?? []} />
              </>
            )}
          </Panel>
          <div
            css={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: theme.spacing.lg,
            }}
          >
            <CpuPanel cpu={snapshot.cpu} />
            <MemoryPanel memory={snapshot.memory} swap={snapshot.swap} />
            <DiskPanel disks={snapshot.disks} />
          </div>
        </div>
      )}
    </ScrollablePageWrapper>
  );
};

export default HardwarePage;
