/**
 * Evaluation adapters and aligned columns rendered by MLflow's native bar plot.
 * Naming: build* creates chart data from selected evaluation snapshots.
 */
import { useMemo } from 'react';
import { useDesignSystemTheme } from '@databricks/design-system';
import { RunPageTabName } from '../../constants';
import Routes from '../../routes';
import { useGetExperimentRunColor } from '../../components/experiment-page/hooks/useExperimentRunColor';
import { EXPERIMENT_RUNS_TABLE_ROW_HEIGHT } from '../../components/experiment-page/utils/experimentPage.common-utils';
import type { RunsChartsRunData } from '../../components/runs-charts/components/RunsCharts.common';
import { RunsMetricsBarPlot } from '../../components/runs-charts/components/RunsMetricsBarPlot';
import { RunsChartsTooltipBody } from '../../components/runs-charts/components/RunsChartsTooltipBody';
import {
  RunsChartsTooltipWrapper,
  useRunsChartsTooltip,
} from '../../components/runs-charts/hooks/useRunsChartsTooltip';
import { RunsChartsBarCardConfig } from '../../components/runs-charts/runs-charts.types';
import type { BenchmarkColumn, BenchmarkRun } from './benchmark.types';
import { buildMetricDifference, buildMetricDifferenceLabel, buildMetricValue } from './benchmarkMetrics';

// ===== Evaluation adapters =====

interface BenchmarkChartsProps {
  experimentId: string;
  runs: BenchmarkRun[];
  columns: BenchmarkColumn[];
  columnWidths: Record<string, number>;
  baselineRunId: string | null;
  onHideRun: (runId: string) => void;
}

const buildMetricKey = (column: BenchmarkColumn): string => `${column.group.dataset_name} / ${column.metric}`;

const buildChartData = (
  runs: BenchmarkRun[],
  columns: BenchmarkColumn[],
  getRunColor: (runId: string) => string,
): RunsChartsRunData[] => {
  return runs.map((run) => {
    const metrics: RunsChartsRunData['metrics'] = {};
    columns.forEach((column) => {
      const evaluation = column.evaluations.get(run.run_id);
      const value = evaluation?.metrics[column.metric];
      if (typeof value === 'number' && Number.isFinite(value)) {
        const key = buildMetricKey(column);
        metrics[key] = { key, value, step: 0, timestamp: evaluation?.evaluation_time ?? 0 };
      }
    });
    return {
      uuid: run.run_id,
      displayName: run.run_name || run.run_id,
      metrics,
      params: {},
      tags: {},
      images: {},
      color: getRunColor(run.run_id),
    };
  });
};

// ===== Aligned native plot columns =====

const BenchmarkChartColumn = ({
  column,
  chartData,
  width,
  baselineRunId,
}: {
  column: BenchmarkColumn;
  chartData: RunsChartsRunData[];
  width: number;
  baselineRunId: string | null;
}) => {
  const { theme } = useDesignSystemTheme();
  const metricKey = buildMetricKey(column);
  const configuration = useMemo(() => {
    const chart = new RunsChartsBarCardConfig(true, column.key);
    chart.metricKey = metricKey;
    return chart;
  }, [column.key, metricKey]);
  const { setTooltip, resetTooltip, selectedRunUuid } = useRunsChartsTooltip(configuration);
  const orderedRunIds = useMemo(() => chartData.map((run) => run.uuid), [chartData]);
  const height = chartData.length * EXPERIMENT_RUNS_TABLE_ROW_HEIGHT + 32;
  const baselineIndex = baselineRunId ? orderedRunIds.indexOf(baselineRunId) : -1;
  const valueLabels = useMemo(() => {
    const baselineValue = buildMetricValue(column, baselineRunId);
    return Object.fromEntries(
      chartData.map((run) => {
        const value = buildMetricValue(column, run.uuid);
        if (value === null) return [run.uuid, ''];
        const difference = buildMetricDifference(value, baselineValue);
        if (difference === null) return [run.uuid, value.toFixed(3)];
        const color =
          difference > 0
            ? theme.colors.textValidationDanger
            : difference < 0
            ? theme.colors.textValidationSuccess
            : theme.colors.textSecondary;
        return [
          run.uuid,
          `${value.toFixed(3)} <span style="color:${color}">${buildMetricDifferenceLabel(difference)}</span>`,
        ];
      }),
    );
  }, [column, chartData, baselineRunId, theme.colors]);

  return (
    <div
      aria-label={metricKey}
      data-testid="benchmark-chart-column"
      css={{
        flex: '0 0 auto',
        width,
        minWidth: 0,
        height,
        position: 'relative',
        borderRight: `1px solid ${theme.colors.border}`,
        boxSizing: 'border-box',
      }}
    >
      {baselineIndex >= 0 && (
        <div
          data-testid="benchmark-chart-baseline-highlight"
          data-run-id={baselineRunId}
          css={{
            position: 'absolute',
            top: baselineIndex * EXPERIMENT_RUNS_TABLE_ROW_HEIGHT,
            left: 0,
            right: 0,
            height: EXPERIMENT_RUNS_TABLE_ROW_HEIGHT,
            backgroundColor: theme.colors.tableBackgroundSelectedDefault,
            pointerEvents: 'none',
          }}
        />
      )}
      <RunsMetricsBarPlot
        runsData={chartData}
        metricKey={metricKey}
        orderedRunIds={orderedRunIds}
        valueLabels={valueLabels}
        height={height}
        margin={{ t: 0, b: 32, l: 8, r: 8, pad: 0 }}
        displayLegend={false}
        displayRunNames={false}
        displayMetricKey={false}
        useDefaultHoverBox={false}
        onHover={setTooltip}
        onUnhover={resetTooltip}
        selectedRunUuid={selectedRunUuid}
      />
    </div>
  );
};

/** Shares the Run list's row order and height without repeating names or legends. */
export const BenchmarkCharts = ({
  experimentId,
  runs,
  columns,
  columnWidths,
  baselineRunId,
  onHideRun,
}: BenchmarkChartsProps) => {
  const getRunColor = useGetExperimentRunColor();
  const chartData = useMemo(() => buildChartData(runs, columns, getRunColor), [runs, columns, getRunColor]);
  const tooltipContextValue = useMemo(
    () => ({
      runs: chartData,
      onHideRun,
      getDataTraceLink: (_experimentId: string, runId: string) =>
        Routes.getRunPageTabRoute(experimentId, runId, RunPageTabName.EVALUATIONS),
    }),
    [chartData, experimentId, onHideRun],
  );

  return (
    <RunsChartsTooltipWrapper contextData={tooltipContextValue} component={RunsChartsTooltipBody}>
      <div data-testid="benchmark-native-charts" css={{ display: 'flex' }}>
        {columns.map((column) => (
          <BenchmarkChartColumn
            key={column.key}
            column={column}
            chartData={chartData}
            width={columnWidths[column.key]}
            baselineRunId={baselineRunId}
          />
        ))}
      </div>
    </RunsChartsTooltipWrapper>
  );
};
