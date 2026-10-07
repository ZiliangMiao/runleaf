import { useDesignSystemTheme } from '@databricks/design-system';
import { Config, Data, Layout } from 'plotly.js';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { LazyPlot } from '../../LazyPlot';
import { useMutableChartHoverCallback } from '../hooks/useMutableHoverCallback';
import { highlightBarTraces, useRenderRunsChartTraceHighlight } from '../hooks/useRunsChartTraceHighlight';
import {
  commonRunsChartStyles,
  RunsChartsRunData,
  runsChartDefaultMargin,
  runsChartHoverlabel,
  RunsPlotsCommonProps,
  createThemedPlotlyLayout,
  normalizeChartValue,
  useDynamicPlotSize,
  getLegendDataFromRuns,
} from './RunsCharts.common';
import type { MetricEntity } from '../../../types';
import RunsMetricsLegendWrapper from './RunsMetricsLegendWrapper';
import { createChartImageDownloadHandler } from '../hooks/useChartImageDownloadHandler';
import { customMetricBehaviorDefs } from '../../experiment-page/utils/customMetricBehaviorUtils';
import { RunsChartCardLoadingPlaceholder } from './cards/ChartCard.common';

// We're not using params in bar plot
export type BarPlotRunData = Omit<RunsChartsRunData, 'params' | 'tags' | 'images'>;

export interface RunsMetricsBarPlotHoverData {
  xValue: string;
  yValue: number;
  index: number;
  metricEntity?: MetricEntity;
}

export interface RunsMetricsBarPlotProps extends RunsPlotsCommonProps {
  /**
   * Determines which metric are we comparing by
   */
  metricKey: string;

  /**
   * Array of runs data with corresponding values
   */
  runsData: BarPlotRunData[];

  /**
   * Relative width of the plot bar
   */
  barWidth?: number;

  /**
   * Display run names on the Y axis
   */
  displayRunNames?: boolean;

  /**
   * Display metric key on the X axis
   */
  displayMetricKey?: boolean;

  /** Display the run legend below the plot. */
  displayLegend?: boolean;

  /** Reserve one top-to-bottom row per run, including hidden or missing values. */
  orderedRunIds?: string[];

  /** Override displayed metric labels with Plotly-compatible rich text by run ID. */
  valueLabels?: Record<string, string>;
}

const PLOT_CONFIG: Partial<Config> = {
  displaylogo: false,
  scrollZoom: false,
  doubleClick: 'autosize',
  showTips: false,
  modeBarButtonsToRemove: ['toImage'],
};

const Y_AXIS_PARAMS = {
  ticklabelposition: 'inside',
  tickfont: { size: 11 },
  fixedrange: true,
};

const getFixedPointValue = (val: string | number, places = 3) => (typeof val === 'number' ? val.toFixed(places) : val);

/**
 * Implementation of plotly.js chart displaying
 * bar plot comparing metrics for a given
 * set of experiments runs
 */
export const RunsMetricsBarPlot = React.memo(
  ({
    runsData,
    metricKey,
    className,
    margin = runsChartDefaultMargin,
    onUpdate,
    onHover,
    onUnhover,
    barWidth = 3 / 4,
    width,
    height,
    displayRunNames = true,
    useDefaultHoverBox = true,
    displayMetricKey = true,
    displayLegend = true,
    orderedRunIds,
    valueLabels,
    selectedRunUuid,
    onSetDownloadHandler,
  }: RunsMetricsBarPlotProps) => {
    const displayedRunsData = useMemo(() => {
      if (!orderedRunIds) return runsData;
      const runsById = new Map(runsData.map((run) => [run.uuid, run]));
      return orderedRunIds.map((uuid): BarPlotRunData => {
        const run = runsById.get(uuid) ?? { uuid, displayName: uuid, metrics: {} };
        return run.hidden ? { ...run, metrics: {} } : run;
      });
    }, [runsData, orderedRunIds]);

    const orderedYAxis = useMemo<Partial<Layout['yaxis']>>(
      () => ({
        type: orderedRunIds ? 'category' : undefined,
        categoryorder: orderedRunIds ? 'array' : undefined,
        categoryarray: orderedRunIds,
        autorange: orderedRunIds ? false : undefined,
        range: orderedRunIds ? [Math.max(orderedRunIds.length, 1) - 0.5, -0.5] : undefined,
      }),
      [orderedRunIds],
    );

    const plotData = useMemo(() => {
      // Run uuids
      const ids = displayedRunsData.map((d) => d.uuid);

      // Trace names
      const names = displayedRunsData.map(({ displayName }) => displayName);

      // Actual metric values
      const values = displayedRunsData.map((d) => normalizeChartValue(d.metrics[metricKey]?.value));

      // Displayed metric values
      const textValues = displayedRunsData.map((d) => {
        if (valueLabels) {
          return valueLabels[d.uuid];
        }
        const customMetricBehaviorDef = customMetricBehaviorDefs[metricKey];
        if (customMetricBehaviorDef) {
          return customMetricBehaviorDef.valueFormatter({ value: d.metrics[metricKey]?.value });
        }

        return getFixedPointValue(d.metrics[metricKey]?.value);
      });

      // Colors corresponding to each run
      const colors = displayedRunsData.map((d) => d.color);

      return [
        {
          y: ids,
          x: values,
          names,
          text: textValues,
          textposition: valueLabels ? 'none' : values.map((value) => (value === 0 ? 'outside' : 'auto')),
          textfont: {
            size: 11,
          },
          metrics: displayedRunsData.map((d) => d.metrics[metricKey]),
          // Display run name on hover. "<extra></extra>" removes plotly's "extra" tooltip that
          // is unnecessary here.
          type: 'bar' as any,
          hovertemplate: useDefaultHoverBox ? '%{label}<extra></extra>' : undefined,
          hoverinfo: useDefaultHoverBox ? 'y' : 'none',
          hoverlabel: useDefaultHoverBox ? runsChartHoverlabel : undefined,
          width: barWidth,

          orientation: 'h',
          marker: {
            color: colors,
          },
        } as Data & { names: string[] },
      ];
    }, [displayedRunsData, metricKey, barWidth, useDefaultHoverBox, valueLabels]);

    const { layoutHeight, layoutWidth, setContainerDiv, containerDiv, isDynamicSizeSupported } = useDynamicPlotSize();

    const { formatMessage } = useIntl();
    const { theme } = useDesignSystemTheme();
    const plotlyThemedLayout = useMemo(() => createThemedPlotlyLayout(theme), [theme]);
    const plotMargin = useMemo(() => {
      if (!valueLabels) return margin;
      const labelWidth = Math.max(
        0,
        ...Object.values(valueLabels).map((label) => label.replace(/<[^>]*>/g, '').length * 7),
      );
      return { ...margin, r: (margin.r ?? 0) + labelWidth + 4 };
    }, [margin, valueLabels]);
    const valueAnnotations = useMemo<Partial<Layout>['annotations']>(() => {
      if (!valueLabels) return undefined;
      // Reserve a label area outside the bars to preserve lengths and difference colors.
      return displayedRunsData
        .filter((run) => valueLabels[run.uuid])
        .map((run) => ({
          name: run.uuid,
          text: valueLabels[run.uuid],
          xref: 'paper',
          x: 1,
          xshift: 4,
          xanchor: 'left',
          yref: 'y',
          y: run.uuid,
          yanchor: 'middle',
          showarrow: false,
          captureevents: false,
          font: { size: 11, color: theme.colors.textPrimary },
          borderpad: 0,
        }));
    }, [displayedRunsData, valueLabels, theme.colors.textPrimary]);

    const [layout, setLayout] = useState<Partial<Layout>>({
      width: width || layoutWidth,
      height: height || layoutHeight,
      hovermode: 'y',
      margin: plotMargin,
      annotations: valueAnnotations,
      xaxis: {
        title: displayMetricKey ? metricKey : undefined,
        tickfont: { size: 11, color: theme.colors.textSecondary },
        tickformat: customMetricBehaviorDefs[metricKey]?.chartAxisTickFormat ?? undefined,
      },
      yaxis: {
        showticklabels: displayRunNames,
        title: displayRunNames
          ? formatMessage({
              defaultMessage: 'Run name',
              description: 'Label for Y axis in bar chart when comparing metrics between runs',
            })
          : undefined,
        tickfont: { size: 11, color: theme.colors.textSecondary },
        fixedrange: true,
        ...orderedYAxis,
      },
      template: { layout: plotlyThemedLayout },
    });

    useEffect(() => {
      setLayout((current) => ({
        ...current,
        width: width || layoutWidth,
        height: height || layoutHeight,
        margin: plotMargin,
        annotations: valueAnnotations,
        xaxis: {
          ...current.xaxis,
          title: displayMetricKey ? metricKey : undefined,
        },
        yaxis: { ...current.yaxis, ...orderedYAxis },
      }));
    }, [
      layoutWidth,
      layoutHeight,
      plotMargin,
      metricKey,
      width,
      height,
      displayMetricKey,
      orderedYAxis,
      valueAnnotations,
    ]);

    const { setHoveredPointIndex } = useRenderRunsChartTraceHighlight(
      containerDiv,
      selectedRunUuid,
      displayedRunsData,
      highlightBarTraces,
    );

    const hoverCallback = useCallback(
      ({ points, event }) => {
        const metricEntity = points[0].data?.metrics[points[0].pointIndex];
        setHoveredPointIndex(points[0]?.pointIndex ?? -1);

        const hoverData: RunsMetricsBarPlotHoverData = {
          xValue: points[0].x,
          yValue: points[0].value,
          // The index of the X datum
          index: points[0].pointIndex,
          metricEntity,
        };

        const runUuid = points[0]?.label;
        if (runUuid) {
          onHover?.(runUuid, event, hoverData);
        }
      },
      [onHover, setHoveredPointIndex],
    );

    const unhoverCallback = useCallback(() => {
      onUnhover?.();
      setHoveredPointIndex(-1);
    }, [onUnhover, setHoveredPointIndex]);

    /**
     * Unfortunately plotly.js memorizes first onHover callback given on initial render,
     * so in order to achieve updated behavior we need to wrap its most recent implementation
     * in the immutable callback.
     */
    const mutableHoverCallback = useMutableChartHoverCallback(hoverCallback);

    const legendLabelData = useMemo(() => getLegendDataFromRuns(displayedRunsData), [displayedRunsData]);

    useEffect(() => {
      // Prepare layout and data traces to export
      const layoutToExport = {
        ...layout,
        yaxis: {
          ...layout.yaxis,
          showticklabels: true,
          automargin: true,
          ...(orderedRunIds
            ? {
                tickmode: 'array' as const,
                tickvals: orderedRunIds,
                ticktext: displayedRunsData.map(({ displayName }) => displayName),
              }
            : {}),
        },
      };

      const dataToExport = plotData.map((trace) => ({
        ...trace,
        // Keep unique categories when aligned runs share a display name.
        y: orderedRunIds ?? trace.names,
      }));
      onSetDownloadHandler?.(createChartImageDownloadHandler(dataToExport, layoutToExport));
    }, [layout, onSetDownloadHandler, plotData, orderedRunIds, displayedRunsData]);

    const chart = (
      <div
        css={[commonRunsChartStyles.chartWrapper(theme), styles.highlightStyles]}
        className={className}
        ref={setContainerDiv}
      >
        <LazyPlot
          data={plotData}
          useResizeHandler={!isDynamicSizeSupported}
          css={commonRunsChartStyles.chart(theme)}
          onUpdate={onUpdate}
          layout={layout}
          config={PLOT_CONFIG}
          onHover={mutableHoverCallback}
          onUnhover={unhoverCallback}
          fallback={<RunsChartCardLoadingPlaceholder />}
        />
      </div>
    );

    return displayLegend ? (
      <RunsMetricsLegendWrapper labelData={legendLabelData}>{chart}</RunsMetricsLegendWrapper>
    ) : (
      chart
    );
  },
);

const styles = {
  highlightStyles: {
    '.trace.bars g.point path': {
      transition: 'var(--trace-transition)',
    },
    '.trace.bars.is-highlight g.point path': {
      opacity: 'var(--trace-opacity-dimmed-high) !important',
    },
    '.trace.bars g.point.is-hover-highlight path': {
      opacity: 'var(--trace-opacity-highlighted) !important',
    },
    '.trace.bars g.point.is-selection-highlight path': {
      opacity: 'var(--trace-opacity-highlighted) !important',
      stroke: 'var(--trace-stroke-color)',
      strokeWidth: 'var(--trace-stroke-width) !important',
    },
  },
};
