/**
 * Run monitors: chart configuration, chart display, and persisted state.
 * Naming table: build* constructs grouped charts; RunView* renders monitor views.
 */
import { ToggleButton, useDesignSystemTheme } from '@databricks/design-system';
import { compact, isEqual, mapValues, noop, pickBy, values } from 'lodash';
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { useSelector } from 'react-redux';
import { ReduxState } from '../../../redux-types';
import type { KeyValueEntity, MetricEntitiesByName, RunInfoEntity } from '../../types';

import { RunsChartsTooltipWrapper } from '../runs-charts/hooks/useRunsChartsTooltip';
import { RunViewChartTooltipBody } from './RunViewChartTooltipBody';
import { RunsChartType, RunsChartsCardConfig, RunsChartsLineCardConfig } from '../runs-charts/runs-charts.types';
import type { RunsChartsRunData } from '../runs-charts/components/RunsCharts.common';
import { RunsChartsLineChartXAxisType } from '../runs-charts/components/RunsCharts.common';
import type { ExperimentRunsChartsUIConfiguration } from '../experiment-page/models/ExperimentPageUIState';
import { RunsChartsLineChartCard } from '../runs-charts/components/cards/RunsChartsLineChartCard';
import { RunsChartsUIConfigurationContextProvider } from '../runs-charts/hooks/useRunsChartsUIConfiguration';
import LocalStorageUtils from '../../../common/utils/LocalStorageUtils';
import { RunsChartsFullScreenModal } from '../runs-charts/components/RunsChartsFullScreenModal';
import { useIsTabActive } from '../../../common/hooks/useIsTabActive';
import { shouldEnableRunDetailsPageAutoRefresh } from '../../../common/utils/FeatureUtils';
import type { UseGetRunQueryResponseRunInfo } from './hooks/useGetRunQuery';
import { RunsChartsGlobalChartSettingsDropdown } from '../runs-charts/components/RunsChartsGlobalChartSettingsDropdown';
import { RunsChartsFilterInput } from '../runs-charts/components/RunsChartsFilterInput';
import { getMonitorMetricGroup, isRunMonitorMetricKey } from '../../utils/MetricsUtils';
import { filterRunsChartsMetrics } from '../runs-charts/utils/filterRunsChartsMetrics';

interface RunViewMetricChartsProps {
  metricKeys: string[];
  runInfo: RunInfoEntity | UseGetRunQueryResponseRunInfo;
  /**
   * Whether to display model or system metrics. This affects labels and tooltips.
   */
  mode: 'model' | 'system';

  latestMetrics?: MetricEntitiesByName;
  tags?: Record<string, KeyValueEntity>;
  params?: Record<string, KeyValueEntity>;
}

// ===== Monitor chart configuration =====

/** Builds the monitor's grouped history charts and replaces legacy per-metric layouts. */
export const buildRunMonitorCharts = (
  configuration: ExperimentRunsChartsUIConfiguration,
  mode: 'model' | 'system',
  metricKeys: string[],
): ExperimentRunsChartsUIConfiguration => {
  const groups = mode === 'model' ? ['train', 'val'] : ['gpu', 'cpu', 'mem'];
  const sectionId = `${mode}-monitor`;
  const section = configuration.compareRunSections?.find(({ uuid }) => uuid === sectionId);
  const compareRunCharts = groups.map((group) => {
    const uuid = `${sectionId}-${group}`;
    const previous = configuration.compareRunCharts?.find((chart) => chart.uuid === uuid);
    const selectedMetricKeys = [...new Set(metricKeys)].filter((key) => getMonitorMetricGroup(key) === group).sort();
    return {
      ...new RunsChartsLineCardConfig(true, uuid, sectionId),
      ...previous,
      xAxisKey: mode === 'system' ? RunsChartsLineChartXAxisType.TIME : RunsChartsLineChartXAxisType.STEP,
      type: RunsChartType.LINE,
      metricSectionId: sectionId,
      displayName: group,
      deleted: false,
      metricKey: selectedMetricKeys[0] ?? '',
      selectedMetricKeys,
    };
  });
  const next = {
    ...configuration,
    compareRunCharts,
    compareRunSections: [
      {
        ...section,
        uuid: sectionId,
        name: mode === 'model' ? 'Model Monitor' : 'System Monitor',
        display: section?.display ?? true,
        isReordered: false,
        deleted: false,
        isGenerated: true,
      },
    ],
    globalLineChartConfig: {
      lineSmoothness: 0,
      selectedXAxisMetricKey: '',
      ...configuration.globalLineChartConfig,
      xAxisKey: section
        ? configuration.globalLineChartConfig?.xAxisKey ?? RunsChartsLineChartXAxisType.STEP
        : mode === 'system'
        ? RunsChartsLineChartXAxisType.TIME
        : RunsChartsLineChartXAxisType.STEP,
    },
  };
  return isEqual(configuration, next) ? configuration : next;
};

// ===== Monitor chart display =====

/**
 * Component displaying metric charts for a single run
 */
const RunViewMetricChartsImpl = ({
  runInfo,
  metricKeys,
  mode,
  chartUIState,
  updateChartsUIState,
  latestMetrics = {},
  params = {},
  tags = {},
}: RunViewMetricChartsProps & {
  chartUIState: ExperimentRunsChartsUIConfiguration;
  updateChartsUIState: (
    stateSetter: (state: ExperimentRunsChartsUIConfiguration) => ExperimentRunsChartsUIConfiguration,
  ) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const { formatMessage } = useIntl();

  const { compareRunCharts, chartsSearchFilter } = chartUIState;

  const visibleChartCards = useMemo(() => {
    const charts = (compareRunCharts ?? []) as RunsChartsLineCardConfig[];
    if (!chartsSearchFilter) {
      return charts;
    }
    try {
      const pattern = new RegExp(chartsSearchFilter, 'i');
      return charts.filter((chart) =>
        [chart.displayName ?? '', ...(chart.selectedMetricKeys ?? [])].some((key) => pattern.test(key)),
      );
    } catch {
      return charts;
    }
  }, [compareRunCharts, chartsSearchFilter]);

  const [fullScreenChart, setFullScreenChart] = useState<
    | {
        config: RunsChartsCardConfig;
        title: string | ReactNode;
        subtitle: ReactNode;
      }
    | undefined
  >(undefined);

  const metricsForRun = useSelector(({ entities }: ReduxState) => {
    return mapValues(entities.sampledMetricsByRunUuid[runInfo.runUuid ?? ''], (metricsByRange) => {
      return compact(
        values(metricsByRange)
          .map(({ metricsHistory }) => metricsHistory)
          .flat(),
      );
    });
  });

  const tooltipContextValue = useMemo(() => ({ runInfo, metricsForRun }), [runInfo, metricsForRun]);

  // Create a single run data object to be used in charts
  const chartData: RunsChartsRunData[] = useMemo(
    () => [
      {
        displayName: runInfo.runName ?? '',
        metrics: latestMetrics,
        params,
        tags,
        images: {},
        metricHistory: {},
        uuid: runInfo.runUuid ?? '',
        color: theme.colors.primary,
        runInfo,
      },
    ],
    [runInfo, latestMetrics, params, tags, theme],
  );

  useEffect(() => {
    updateChartsUIState((current) => buildRunMonitorCharts(current, mode, metricKeys));
  }, [metricKeys, updateChartsUIState, mode]);

  const isTabActive = useIsTabActive();
  const autoRefreshEnabled = chartUIState.autoRefreshEnabled && shouldEnableRunDetailsPageAutoRefresh() && isTabActive;

  return (
    <div
      css={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        css={{
          paddingBottom: theme.spacing.md,
          display: 'flex',
          gap: theme.spacing.sm,
          flex: '0 0 auto',
        }}
      >
        <RunsChartsFilterInput chartsSearchFilter={chartsSearchFilter} />
        {shouldEnableRunDetailsPageAutoRefresh() && (
          <ToggleButton
            componentId="codegen_mlflow_app_src_experiment-tracking_components_run-page_runviewmetricchartsv2.tsx_244"
            pressed={chartUIState.autoRefreshEnabled}
            onPressedChange={(pressed) => {
              updateChartsUIState((current) => ({ ...current, autoRefreshEnabled: pressed }));
            }}
          >
            {formatMessage({
              defaultMessage: 'Auto-refresh',
              description: 'Run page > Charts tab > Auto-refresh toggle button',
            })}
          </ToggleButton>
        )}
        <RunsChartsGlobalChartSettingsDropdown
          metricKeyList={metricKeys}
          globalLineChartConfig={chartUIState.globalLineChartConfig}
          updateUIState={updateChartsUIState}
        />
      </div>
      <div
        css={{
          flex: 1,
          overflow: 'auto',
        }}
      >
        <RunsChartsTooltipWrapper contextData={tooltipContextValue} component={RunViewChartTooltipBody}>
          <div
            css={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 480px), 1fr))',
              gap: theme.spacing.md,
            }}
          >
            {visibleChartCards.map((config, index) => (
              <RunsChartsLineChartCard
                key={config.uuid}
                config={config}
                chartRunData={chartData}
                groupBy={null}
                onReorderWith={noop}
                canMoveUp={false}
                canMoveDown={false}
                positionInSection={index}
                isInViewport
                isInViewportDeferred
                setFullScreenChart={setFullScreenChart}
                autoRefreshEnabled={autoRefreshEnabled}
                globalLineChartConfig={chartUIState.globalLineChartConfig}
              />
            ))}
          </div>
        </RunsChartsTooltipWrapper>
      </div>
      <RunsChartsFullScreenModal
        fullScreenChart={fullScreenChart}
        onCancel={() => setFullScreenChart(undefined)}
        chartData={chartData}
        tooltipContextValue={tooltipContextValue}
        tooltipComponent={RunViewChartTooltipBody}
        autoRefreshEnabled={autoRefreshEnabled}
        globalLineChartConfig={chartUIState.globalLineChartConfig}
        groupBy={null}
      />
    </div>
  );
};

// ===== Monitor state and entry point =====

export const RunViewMetricCharts = (props: RunViewMetricChartsProps) => {
  const persistenceIdentifier = `${props.runInfo.runUuid}-${props.mode}-monitor`;

  const localStore = useMemo(
    () => LocalStorageUtils.getStoreForComponent('RunPage', persistenceIdentifier),
    [persistenceIdentifier],
  );

  const [chartUIState, updateChartsUIState] = useState<ExperimentRunsChartsUIConfiguration>(() => {
    const defaultChartState: ExperimentRunsChartsUIConfiguration = {
      isAccordionReordered: false,
      compareRunCharts: undefined,
      compareRunSections: undefined,
      // Auto-refresh is enabled by default only if the flag is set
      autoRefreshEnabled: shouldEnableRunDetailsPageAutoRefresh(),
      globalLineChartConfig: {
        xAxisKey: props.mode === 'system' ? RunsChartsLineChartXAxisType.TIME : RunsChartsLineChartXAxisType.STEP,
        lineSmoothness: 0,
        selectedXAxisMetricKey: '',
      },
    };
    try {
      const persistedChartState = localStore.getItem('chartUIState');

      if (!persistedChartState) {
        return defaultChartState;
      }
      return JSON.parse(persistedChartState);
    } catch {
      return defaultChartState;
    }
  });

  useEffect(() => {
    localStore.setItem('chartUIState', JSON.stringify(chartUIState));
  }, [chartUIState, localStore]);

  const includeMetric = useCallback(
    (name: string) => {
      const group = getMonitorMetricGroup(name);
      return props.mode === 'system'
        ? (group === 'gpu' || group === 'cpu' || group === 'mem') && isRunMonitorMetricKey(name, props.params)
        : group === 'train' || group === 'val';
    },
    [props.mode, props.params],
  );
  const visibleMetricKeys = useMemo(() => props.metricKeys.filter(includeMetric), [props.metricKeys, includeMetric]);
  const visibleMetrics = useMemo(
    () => pickBy(props.latestMetrics, (_, name) => includeMetric(name)),
    [props.latestMetrics, includeMetric],
  );
  const visibleChartUIState = useMemo(
    () => buildRunMonitorCharts(filterRunsChartsMetrics(chartUIState, includeMetric), props.mode, visibleMetricKeys),
    [chartUIState, includeMetric, props.mode, visibleMetricKeys],
  );

  return (
    <RunsChartsUIConfigurationContextProvider updateChartsUIState={updateChartsUIState}>
      <RunViewMetricChartsImpl
        {...props}
        metricKeys={visibleMetricKeys}
        latestMetrics={visibleMetrics}
        chartUIState={visibleChartUIState}
        updateChartsUIState={updateChartsUIState}
      />
    </RunsChartsUIConfigurationContextProvider>
  );
};
