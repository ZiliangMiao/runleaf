/**
 * Benchmark selection, sortable comparison table, then the experiment page.
 * Naming: fetch* reads results; build* derives selections; compare* orders runs.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Empty,
  LegacySelect,
  SegmentedControlButton,
  SegmentedControlGroup,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import { getJson } from '../../../common/utils/FetchUtils';
import { Link } from '../../../common/utils/RoutingUtils';
import { RunsChartsSetHighlightContextProvider } from '../../components/runs-charts/hooks/useRunsChartTraceHighlight';
import { RunPageTabName } from '../../constants';
import Routes from '../../routes';
import { BenchmarkCharts } from './BenchmarkCharts';
import { BenchmarkRunList } from './BenchmarkRunList';
import { buildMetricDifference, buildMetricDifferenceLabel, buildMetricValue } from './benchmarkMetrics';
import type { BenchmarkColumn, BenchmarkGroup, BenchmarkRun, ExperimentBenchmarks } from './benchmark.types';

// ===== Selection helpers =====

interface BenchmarkSort {
  key: string;
  direction: 'asc' | 'desc';
}

const fetchExperimentBenchmarks = async (experimentId: string): Promise<ExperimentBenchmarks> => {
  try {
    return (await getJson({
      relativeUrl: `ajax-api/2.0/deeplore/experiments/${encodeURIComponent(experimentId)}/benchmarks`,
    })) as ExperimentBenchmarks;
  } catch (error) {
    throw error instanceof ErrorWrapper ? new Error(error.getMessageField()) : error;
  }
};

const buildGroupKey = (group: BenchmarkGroup): string => JSON.stringify([group.dataset_name, group.test_hash]);

const buildGroupLabel = (group: BenchmarkGroup): string => group.first_dataset_version ?? '';

const buildMetricNames = (group: BenchmarkGroup): string[] => [...new Set(group.metric_names)].sort();

const buildDefaultGroup = (groups: BenchmarkGroup[]): BenchmarkGroup =>
  [...groups].sort(
    (left, right) =>
      Number(right.evaluations.length > 0) - Number(left.evaluations.length > 0) ||
      buildGroupLabel(right).localeCompare(buildGroupLabel(left), undefined, { numeric: true }) ||
      right.evaluations.length - left.evaluations.length,
  )[0];

const buildDefaultMetrics = (group: BenchmarkGroup): string[] => {
  const recordedMetrics = [
    ...new Set(
      group.evaluations.flatMap((evaluation) =>
        Object.entries(evaluation.metrics)
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([name]) => name),
      ),
    ),
  ].sort();
  return (recordedMetrics.length ? recordedMetrics : buildMetricNames(group)).slice(0, 1);
};

const compareRunNumbers = (left: BenchmarkRun, right: BenchmarkRun): number =>
  (left.run_num ?? Infinity) - (right.run_num ?? Infinity) || left.run_id.localeCompare(right.run_id);

const compareRuns = (
  left: BenchmarkRun,
  right: BenchmarkRun,
  sort: BenchmarkSort,
  column?: BenchmarkColumn,
): number => {
  const leftValue = column ? buildMetricValue(column, left.run_id) : left.run_num;
  const rightValue = column ? buildMetricValue(column, right.run_id) : right.run_num;
  if (leftValue === null) return rightValue === null ? compareRunNumbers(left, right) : 1;
  if (rightValue === null) return -1;
  return (leftValue - rightValue) * (sort.direction === 'asc' ? 1 : -1) || compareRunNumbers(left, right);
};

// ===== Sortable comparison table =====

const BenchmarkComparison = ({
  experimentId,
  runs,
  columns,
  sort,
  view,
  visibleRunIds,
  baselineRunId,
  onBaselineRunIdChange,
  runColumnWidth,
  columnWidths,
  onRunColumnWidthChange,
  onColumnWidthsChange,
  onSort,
  onVisibleRunIdsChange,
}: {
  experimentId: string;
  runs: BenchmarkRun[];
  columns: BenchmarkColumn[];
  sort: BenchmarkSort;
  view: string;
  visibleRunIds: string[];
  baselineRunId: string | null;
  onBaselineRunIdChange: (runId: string | null) => void;
  runColumnWidth: number;
  columnWidths: Record<string, number>;
  onRunColumnWidthChange: (width: number) => void;
  onColumnWidthsChange: Dispatch<SetStateAction<Record<string, number>>>;
  onSort: (key: string) => void;
  onVisibleRunIdsChange: (runIds: string[]) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => resizeCleanup.current?.(), []);

  const visibleRuns = runs.filter((run) => visibleRunIds.includes(run.run_id));
  const baselineRun = runs.find((run) => run.run_id === baselineRunId);
  const automaticColumns = columns.filter((column) => columnWidths[column.key] === undefined).length;
  const availableWidth =
    containerWidth - runColumnWidth - columns.reduce((sum, column) => sum + (columnWidths[column.key] ?? 0), 0);
  const defaultWidth = Math.max(220, availableWidth / Math.max(automaticColumns, 1));
  const resolvedWidths = Object.fromEntries(
    columns.map((column) => [column.key, columnWidths[column.key] ?? defaultWidth]),
  );
  const metricsWidth = columns.reduce((sum, column) => sum + resolvedWidths[column.key], 0);
  const metricCellStyles = (column: BenchmarkColumn) => ({
    flex: '0 0 auto',
    width: resolvedWidths[column.key],
    minWidth: 0,
    boxSizing: 'border-box' as const,
    borderRight: `1px solid ${theme.colors.border}`,
  });

  const resizeColumn = (column: BenchmarkColumn, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const initialX = event.clientX;
    const initialWidth = resolvedWidths[column.key];
    // Freeze automatic widths so dragging one column does not resize its neighbors.
    const frozenWidths = resolvedWidths;
    const updateWidth = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const width = Math.max(140, initialWidth + pointer.clientX - initialX);
      onColumnWidthsChange((current) => ({ ...current, ...frozenWidths, [column.key]: width }));
    };
    const finishResize = () => {
      handle.removeEventListener('pointermove', updateWidth);
      handle.removeEventListener('pointerup', finishResize);
      handle.removeEventListener('pointercancel', finishResize);
      handle.removeEventListener('lostpointercapture', finishResize);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      resizeCleanup.current = null;
      setResizingColumn(null);
    };
    resizeCleanup.current = finishResize;
    handle.setPointerCapture(pointerId);
    handle.addEventListener('pointermove', updateWidth);
    handle.addEventListener('pointerup', finishResize);
    handle.addEventListener('pointercancel', finishResize);
    handle.addEventListener('lostpointercapture', finishResize);
    setResizingColumn(column.key);
  };

  return (
    <div
      ref={containerRef}
      aria-label="Benchmark comparison"
      css={{
        overflow: 'auto',
        flex: 1,
        minHeight: 0,
        borderTop: `1px solid ${theme.colors.border}`,
        '.ag-theme-balham': { fontFamily: 'inherit' },
        '&& [role="columnheader"]': {
          fontFamily: 'inherit',
          fontSize: theme.typography.fontSizeBase,
          fontWeight: theme.typography.typographyBoldFontWeight,
          lineHeight: theme.typography.lineHeightBase,
          color: theme.colors.textPrimary,
          backgroundColor: theme.colors.backgroundSecondary,
          alignItems: 'center',
        },
        '[role="columnheader"] button, [role="columnheader"] [role="button"]': {
          font: 'inherit',
          alignItems: 'center',
        },
        '[aria-label="Resize Column"]': { touchAction: 'none' },
      }}
    >
      <div css={{ display: 'flex', width: runColumnWidth + metricsWidth, alignItems: 'flex-start' }}>
        <BenchmarkRunList
          experimentId={experimentId}
          runs={runs}
          visibleRunIds={visibleRunIds}
          onVisibleRunIdsChange={onVisibleRunIdsChange}
          baselineRunId={baselineRunId}
          onBaselineRunIdChange={onBaselineRunIdChange}
          sortDirection={sort.key === 'run_num' ? sort.direction : 'none'}
          onSort={() => onSort('run_num')}
          width={runColumnWidth}
          onWidthChange={(width) => {
            onColumnWidthsChange((current) => ({ ...current, ...resolvedWidths }));
            onRunColumnWidthChange(width);
          }}
        />
        <div css={{ flex: '0 0 auto', width: metricsWidth, minWidth: 0 }}>
          <Table
            noMinHeight
            aria-label="Benchmark comparison table"
            css={{
              position: view === 'CHART' ? 'sticky' : undefined,
              top: 0,
              zIndex: 1,
              '[role="columnheader"] .table-header-icon-container': { display: 'inline', alignSelf: 'center' },
            }}
          >
            <TableRow isHeader css={{ height: 48, minHeight: 48, position: 'sticky', top: 0, zIndex: 1 }}>
              {columns.map((column) => (
                <TableHeader
                  componentId="mlflow.benchmarks.metric"
                  key={column.key}
                  css={{ ...metricCellStyles(column), height: 48 }}
                  wrapContent={false}
                  sortable
                  sortDirection={sort.key === column.key ? sort.direction : 'none'}
                  onToggleSort={() => onSort(column.key)}
                  resizable
                  resizeHandler={(event) => resizeColumn(column, event)}
                  isResizing={resizingColumn === column.key}
                >
                  <span
                    title={`${column.group.dataset_name} ${column.metric}`}
                    css={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {column.group.dataset_name}{' '}
                    <Typography.Hint style={{ display: 'inline' }}>{column.metric}</Typography.Hint>
                  </span>
                </TableHeader>
              ))}
            </TableRow>
            {view === 'TABLE' &&
              visibleRuns.map((run) => (
                <TableRow
                  key={run.run_id}
                  data-run-id={run.run_id}
                  data-baseline-selected={run.run_id === baselineRunId}
                  style={{
                    backgroundColor:
                      run.run_id === baselineRunId ? theme.colors.tableBackgroundSelectedDefault : undefined,
                  }}
                  css={{ height: 32, minHeight: 32 }}
                >
                  {columns.map((column) => {
                    const value = buildMetricValue(column, run.run_id);
                    const baselineValue = buildMetricValue(column, baselineRunId);
                    const difference = buildMetricDifference(value, baselineValue);
                    return (
                      <TableCell
                        key={column.key}
                        css={{
                          ...metricCellStyles(column),
                          height: 32,
                          paddingTop: 0,
                          paddingBottom: 0,
                          alignItems: 'center',
                        }}
                      >
                        {value !== null && (
                          <span
                            css={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: theme.spacing.sm,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <Link
                              to={Routes.getRunPageTabRoute(experimentId, run.run_id, RunPageTabName.EVALUATIONS)}
                              aria-label={`${run.run_name}: ${column.group.dataset_name} ${column.metric}`}
                            >
                              {value.toFixed(3)}
                            </Link>
                            {difference !== null && (
                              <span
                                data-testid="benchmark-baseline-difference"
                                title={`Difference from ${baselineRun?.run_name}`}
                                css={{
                                  color:
                                    difference > 0
                                      ? theme.colors.textValidationDanger
                                      : difference < 0
                                      ? theme.colors.textValidationSuccess
                                      : theme.colors.textSecondary,
                                }}
                              >
                                {buildMetricDifferenceLabel(difference)}
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
          </Table>
          {view === 'CHART' && visibleRuns.length > 0 && (
            <BenchmarkCharts
              experimentId={experimentId}
              runs={visibleRuns}
              columns={columns}
              baselineRunId={baselineRunId}
              columnWidths={resolvedWidths}
              onHideRun={(runId) => onVisibleRunIdsChange(visibleRunIds.filter((id) => id !== runId))}
            />
          )}
        </div>
      </div>
      {!visibleRuns.length && (
        <Empty title="No runs selected" description="Restore runs using the eye menu beside Run." />
      )}
    </div>
  );
};

// ===== Experiment page =====

/** Compares one selected test content group per benchmark using database evaluations. */
const ExperimentBenchmarksPage = ({ experimentId }: { experimentId: string }) => {
  const { theme } = useDesignSystemTheme();
  const query = useQuery<ExperimentBenchmarks, Error>(
    ['deeplore-experiment-benchmarks', experimentId],
    () => fetchExperimentBenchmarks(experimentId),
    { refetchOnWindowFocus: false, retry: false },
  );
  const [selectedNames, setSelectedNames] = useState<string[]>();
  const [selectedGroups, setSelectedGroups] = useState<Record<string, string>>({});
  const [selectedMetrics, setSelectedMetrics] = useState<Record<string, string[]>>({});
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>();
  const [baselineRunId, setBaselineRunId] = useState<string | null>(null);
  const [sort, setSort] = useState<BenchmarkSort>({ key: 'run_num', direction: 'asc' });
  const [view, setView] = useState('TABLE');
  const [runColumnWidth, setRunColumnWidth] = useState(260);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const groups = (query.data?.benchmarks ?? []).filter((group) => group.first_dataset_version);
  const benchmarkNames = [...new Set(groups.map((group) => group.dataset_name))].sort();
  const evaluatedNames = benchmarkNames.filter((name) =>
    groups.some((group) => group.dataset_name === name && group.evaluations.length > 0),
  );
  const names = (selectedNames ?? evaluatedNames).filter((name) => benchmarkNames.includes(name));
  const selections = names.map((name) => {
    const benchmarkGroups = groups
      .filter((group) => group.dataset_name === name)
      .sort((left, right) => buildGroupLabel(left).localeCompare(buildGroupLabel(right), undefined, { numeric: true }));
    const group =
      benchmarkGroups.find((candidate) => buildGroupKey(candidate) === selectedGroups[name]) ??
      buildDefaultGroup(benchmarkGroups);
    const metricNames = buildMetricNames(group);
    const metrics = (selectedMetrics[name] ?? buildDefaultMetrics(group)).filter((metric) =>
      metricNames.includes(metric),
    );
    return { name, group, benchmarkGroups, metricNames, metrics };
  });
  const columns: BenchmarkColumn[] = selections.flatMap(({ group, metrics }) => {
    const evaluations = new Map(group.evaluations.map((evaluation) => [evaluation.run_id, evaluation]));
    return metrics.map((metric) => ({ key: JSON.stringify([group.dataset_name, metric]), group, metric, evaluations }));
  });
  const sortColumn = columns.find((column) => column.key === sort.key);
  const activeSort: BenchmarkSort = sortColumn
    ? sort
    : { key: 'run_num', direction: sort.key === 'run_num' ? sort.direction : 'asc' };
  const allRuns = [...(query.data?.runs ?? [])].sort((left, right) => compareRuns(left, right, activeSort, sortColumn));
  const runIds = selectedRunIds ?? allRuns.map((run) => run.run_id);
  const toggleSort = (key: string) =>
    setSort({
      key,
      direction:
        activeSort.key === key ? (activeSort.direction === 'asc' ? 'desc' : 'asc') : key === 'run_num' ? 'asc' : 'desc',
    });

  if (query.isLoading) return <Spinner aria-label="Loading benchmarks" />;
  if (query.isError) {
    return (
      <Alert
        componentId="mlflow.benchmarks.error"
        type="error"
        message="Unable to load benchmarks"
        description={query.error.message}
        closable={false}
      />
    );
  }
  if (!benchmarkNames.length) {
    return <Empty title="No benchmarks available" description="This experiment has no recorded benchmarks." />;
  }

  return (
    <RunsChartsSetHighlightContextProvider>
      <section
        aria-label="Experiment benchmarks"
        css={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
      >
        <div
          css={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm, paddingBottom: theme.spacing.sm }}>
            <label htmlFor="benchmark-names">Benchmarks</label>
            <LegacySelect
              id="benchmark-names"
              aria-label="Benchmarks"
              mode="multiple"
              value={names}
              onChange={(value: string[]) => setSelectedNames(value)}
              options={benchmarkNames.map((name) => ({ label: name, value: name }))}
              optionFilterProp="label"
              maxTagCount="responsive"
              css={{ flex: 1, minWidth: 120 }}
            />
            <SegmentedControlGroup
              componentId="mlflow.benchmarks.view"
              name="benchmark-view"
              value={view}
              onChange={(event) => setView(event.target.value)}
            >
              <SegmentedControlButton value="TABLE">Table</SegmentedControlButton>
              <SegmentedControlButton value="CHART">Chart</SegmentedControlButton>
            </SegmentedControlGroup>
          </div>
          <div css={{ paddingBottom: theme.spacing.sm, flexShrink: 0 }}>
            {selections.map(({ name, group, benchmarkGroups, metricNames, metrics }) => (
              <div
                key={name}
                aria-label={`${name} selection`}
                css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm, marginBottom: theme.spacing.xs }}
              >
                <Typography.Text
                  bold
                  css={{ flex: '0 0 140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {name}
                </Typography.Text>
                <label htmlFor={`benchmark-versions-${name}`}>Version</label>
                <LegacySelect
                  id={`benchmark-versions-${name}`}
                  aria-label={`${name} version`}
                  value={buildGroupLabel(group)}
                  onChange={(value: string) => {
                    const selected = benchmarkGroups.find((candidate) => buildGroupLabel(candidate) === value);
                    if (selected) {
                      setSelectedGroups((current) => ({ ...current, [name]: buildGroupKey(selected) }));
                    }
                  }}
                  options={benchmarkGroups.map((candidate) => ({
                    value: buildGroupLabel(candidate),
                    label: buildGroupLabel(candidate),
                  }))}
                  optionFilterProp="label"
                  css={{ flex: '0 1 210px', minWidth: 130 }}
                />
                <label htmlFor={`benchmark-metrics-${name}`}>Metrics</label>
                <LegacySelect
                  id={`benchmark-metrics-${name}`}
                  aria-label={`${name} metrics`}
                  mode="multiple"
                  value={metrics}
                  onChange={(value: string[]) => setSelectedMetrics((current) => ({ ...current, [name]: value }))}
                  options={metricNames.map((metric) => ({ value: metric, label: metric }))}
                  optionFilterProp="label"
                  maxTagCount="responsive"
                  css={{ flex: 1, minWidth: 120 }}
                />
              </div>
            ))}
          </div>
          {!columns.length ? (
            <Empty title="No comparison selected" description="Select a benchmark, version, and metric." />
          ) : (
            <BenchmarkComparison
              experimentId={experimentId}
              runs={allRuns}
              columns={columns}
              sort={activeSort}
              view={view}
              visibleRunIds={runIds}
              baselineRunId={baselineRunId}
              onBaselineRunIdChange={setBaselineRunId}
              runColumnWidth={runColumnWidth}
              columnWidths={columnWidths}
              onRunColumnWidthChange={setRunColumnWidth}
              onColumnWidthsChange={setColumnWidths}
              onSort={toggleSort}
              onVisibleRunIdsChange={setSelectedRunIds}
            />
          )}
        </div>
      </section>
    </RunsChartsSetHighlightContextProvider>
  );
};

export default ExperimentBenchmarksPage;
