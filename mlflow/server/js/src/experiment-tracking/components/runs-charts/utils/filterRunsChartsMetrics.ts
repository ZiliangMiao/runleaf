/**
 * Filter persisted chart metrics: axis settings, chart cards, then chart configuration.
 * Naming: filter* retains metric references allowed in the current view.
 */
import type {
  ExperimentRunsChartsUIConfiguration,
  RunsChartsGlobalLineChartConfig,
} from '../../experiment-page/models/ExperimentPageUIState';
import { RunsChartsLineChartXAxisType } from '../components/RunsCharts.common';
import {
  RunsChartType,
  RunsChartsLineChartYAxisType,
  type RunsChartsBarCardConfig,
  type RunsChartsCardConfig,
  type RunsChartsContourCardConfig,
  type RunsChartsLineCardConfig,
  type RunsChartsParallelCardConfig,
  type RunsChartsScatterCardConfig,
} from '../runs-charts.types';

// ===== Axis settings =====

const filterXAxisMetrics = <T extends RunsChartsGlobalLineChartConfig>(
  config: T,
  include: (name: string) => boolean,
): T =>
  config.selectedXAxisMetricKey && !include(config.selectedXAxisMetricKey)
    ? { ...config, xAxisKey: RunsChartsLineChartXAxisType.STEP, selectedXAxisMetricKey: '' }
    : config;

// ===== Chart cards =====

const filterChartMetrics = (
  config: RunsChartsCardConfig,
  include: (name: string) => boolean,
): RunsChartsCardConfig[] => {
  if (config.type === RunsChartType.BAR) {
    return include((config as RunsChartsBarCardConfig).metricKey) ? [config] : [];
  }
  if (config.type === RunsChartType.LINE) {
    const line = config as RunsChartsLineCardConfig;
    const originalKeys = line.selectedMetricKeys ?? [line.metricKey];
    const selectedMetricKeys = originalKeys.filter(include);
    const yAxisExpressions = line.yAxisExpressions?.filter((expression) => expression.variables.every(include));
    const usesExpressions = line.yAxisKey === RunsChartsLineChartYAxisType.EXPRESSION;
    if (usesExpressions ? !yAxisExpressions?.length : originalKeys.length > 0 && !selectedMetricKeys.length) {
      return [];
    }
    return [
      filterXAxisMetrics(
        {
          ...line,
          metricKey: include(line.metricKey) ? line.metricKey : selectedMetricKeys[0] ?? '',
          selectedMetricKeys: line.selectedMetricKeys ? selectedMetricKeys : undefined,
          yAxisExpressions,
        },
        include,
      ),
    ];
  }
  if (config.type === RunsChartType.PARALLEL) {
    const parallel = config as RunsChartsParallelCardConfig;
    const selectedMetrics = parallel.selectedMetrics.filter(include);
    const filtered: RunsChartsParallelCardConfig = { ...parallel, selectedMetrics };
    return parallel.selectedMetrics.length && !selectedMetrics.length && !parallel.selectedParams.length
      ? []
      : [filtered];
  }
  if (config.type === RunsChartType.SCATTER || config.type === RunsChartType.CONTOUR) {
    const axes = config as RunsChartsScatterCardConfig | RunsChartsContourCardConfig;
    return [axes.xaxis, axes.yaxis, ...('zaxis' in axes ? [axes.zaxis] : [])].every(
      (axis) => axis.type !== 'METRIC' || include(axis.key),
    )
      ? [config]
      : [];
  }
  return [config];
};

// ===== Chart configuration =====

/** Removes excluded references from saved charts while retaining their allowed traces. */
export const filterRunsChartsMetrics = <
  T extends Pick<
    ExperimentRunsChartsUIConfiguration,
    'compareRunCharts' | 'compareRunSections' | 'globalLineChartConfig'
  >,
>(
  configuration: T,
  include: (name: string) => boolean,
): T => {
  const compareRunCharts = configuration.compareRunCharts?.flatMap((chart) => filterChartMetrics(chart, include));
  return {
    ...configuration,
    compareRunCharts,
    compareRunSections: configuration.compareRunSections?.filter(
      (section) =>
        !configuration.compareRunCharts?.some((chart) => chart.metricSectionId === section.uuid) ||
        compareRunCharts?.some((chart) => chart.metricSectionId === section.uuid),
    ),
    globalLineChartConfig: configuration.globalLineChartConfig
      ? filterXAxisMetrics(configuration.globalLineChartConfig, include)
      : undefined,
  };
};
