import React from 'react';

import RunsMetricsLegend, { LegendLabelData } from './RunsMetricsLegend';
import { useDesignSystemTheme } from '@databricks/design-system';

const RunsMetricsLegendWrapper = ({
  labelData,
  fullScreen,
  isRunMonitor,
  onSetAllMetricsVisible,
  children,
}: React.PropsWithChildren<{
  labelData: LegendLabelData[];
  fullScreen?: boolean;
  isRunMonitor?: boolean;
  onSetAllMetricsVisible?: (visible: boolean) => void;
}>) => {
  const { theme } = useDesignSystemTheme();

  const FULL_SCREEN_LEGEND_HEIGHT = 100;
  const LEGEND_HEIGHT = 32;
  const SELECTABLE_LEGEND_HEIGHT = 64;
  const MONITOR_LEGEND_HEIGHT = 120;
  const FULL_SCREEN_MONITOR_LEGEND_HEIGHT = 128;

  const height = isRunMonitor
    ? fullScreen
      ? FULL_SCREEN_MONITOR_LEGEND_HEIGHT
      : MONITOR_LEGEND_HEIGHT
    : fullScreen
    ? FULL_SCREEN_LEGEND_HEIGHT
    : labelData.some(({ onToggle }) => onToggle)
    ? SELECTABLE_LEGEND_HEIGHT
    : LEGEND_HEIGHT;
  const heightBuffer = fullScreen ? theme.spacing.lg : theme.spacing.md;

  return (
    <>
      <div css={{ height: `calc(100% - ${height + heightBuffer}px)` }}>{children}</div>
      <RunsMetricsLegend
        labelData={labelData}
        height={height}
        fullScreen={fullScreen}
        isRunMonitor={isRunMonitor}
        onSetAllMetricsVisible={onSetAllMetricsVisible}
      />
    </>
  );
};

export default RunsMetricsLegendWrapper;
