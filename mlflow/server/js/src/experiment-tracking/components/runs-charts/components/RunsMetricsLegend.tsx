import { Button, Icon, Typography, VisibleOffIcon, useDesignSystemTheme } from '@databricks/design-system';

import React from 'react';
import { Dash } from 'plotly.js';
import { useIntl } from 'react-intl';
import { ReactComponent as VisibleFillIcon } from '../../../../common/static/icon-visible-fill.svg';

const STROKE_WIDTH = 3;
const VISIBILITY_ICON_SIZE = 20;

/**
 * Replicating plotly.js's dasharrays for each dash type, with smaller spaces
 * https://github.com/plotly/plotly.js/blob/master/src/components/drawing/index.js#L162
 */
const getDashArray = (dashType: Dash) => {
  switch (dashType) {
    case 'dot':
      return `${STROKE_WIDTH}`;
    case 'dash':
      return `${2 * STROKE_WIDTH}, ${STROKE_WIDTH}`;
    case 'longdash':
      return `${3 * STROKE_WIDTH}, ${STROKE_WIDTH}`;
    case 'dashdot':
      return `${2 * STROKE_WIDTH}, ${STROKE_WIDTH}, ${STROKE_WIDTH}, ${STROKE_WIDTH}`;
    case 'longdashdot':
      return `${3 * STROKE_WIDTH}, ${STROKE_WIDTH}, ${STROKE_WIDTH}, ${STROKE_WIDTH}`;
    default:
      return '';
  }
};

export type LegendLabelData = {
  label: string;
  color: string;
  dashStyle?: Dash;
  uuid?: string;
  metricKey?: string;
  checked?: boolean;
  onToggle?: () => void;
};

const TraceLabel: React.FC<LegendLabelData & { isRunMonitor?: boolean }> = ({
  label,
  color,
  dashStyle,
  checked,
  onToggle,
  isRunMonitor,
}) => {
  const { theme } = useDesignSystemTheme();
  const { formatMessage } = useIntl();
  const visibilityLabel = checked
    ? formatMessage(
        { defaultMessage: 'Hide {metric}', description: 'Run monitor legend action for a visible metric' },
        { metric: label },
      )
    : formatMessage(
        { defaultMessage: 'Show {metric}', description: 'Run monitor legend action for a hidden metric' },
        { metric: label },
      );

  const labelContent = (
    <>
      <TraceLabelColorIndicator color={color} dashStyle={dashStyle} />
      <Typography.Text
        color="secondary"
        size="sm"
        title={isRunMonitor ? (onToggle ? visibilityLabel : label) : undefined}
        css={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', minWidth: 0 }}
      >
        {label}
      </Typography.Text>
    </>
  );

  return (
    <div
      css={{
        display: 'flex',
        alignItems: 'center',
        textOverflow: 'ellipsis',
        flexShrink: 0,
        marginRight: isRunMonitor ? 0 : theme.spacing.md,
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      {onToggle ? (
        <label
          title={visibilityLabel}
          css={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            minWidth: 0,
            cursor: 'pointer',
          }}
        >
          <span
            css={{
              position: 'relative',
              width: VISIBILITY_ICON_SIZE,
              height: VISIBILITY_ICON_SIZE,
              flexShrink: 0,
              marginRight: theme.spacing.xs,
            }}
          >
            <input
              type="checkbox"
              data-component-id="mlflow.run_monitor.metric_visibility"
              aria-label={label}
              checked={Boolean(checked)}
              onChange={onToggle}
              css={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                margin: 0,
                opacity: 0,
                cursor: 'pointer',
                '&:focus-visible + span': {
                  outline: `2px solid ${theme.colors.actionPrimaryBackgroundDefault}`,
                  outlineOffset: 1,
                  borderRadius: 2,
                },
              }}
            />
            <span
              css={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: '100%',
                color: theme.colors.textSecondary,
                pointerEvents: 'none',
              }}
            >
              {checked ? <Icon component={VisibleFillIcon} aria-hidden /> : <VisibleOffIcon aria-hidden />}
            </span>
          </span>
          <span css={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>{labelContent}</span>
        </label>
      ) : (
        labelContent
      )}
    </div>
  );
};

export const TraceLabelColorIndicator: React.FC<Pick<LegendLabelData, 'color' | 'dashStyle'>> = ({
  color,
  dashStyle,
}) => {
  const { theme } = useDesignSystemTheme();
  const strokeDasharray = dashStyle ? getDashArray(dashStyle) : undefined;
  const pathYOffset = theme.typography.fontSizeSm / 2;

  return (
    <svg
      css={{
        height: theme.typography.fontSizeSm,
        width: STROKE_WIDTH * 8,
        marginRight: theme.spacing.xs,
        flexShrink: 0,
      }}
    >
      <path
        d={`M0,${pathYOffset}h${STROKE_WIDTH * 8}`}
        style={{
          strokeWidth: STROKE_WIDTH,
          stroke: color,
          strokeDasharray,
        }}
      />
    </svg>
  );
};
type RunsMetricsLegendProps = {
  labelData: LegendLabelData[];
  height: number;
  fullScreen?: boolean;
  isRunMonitor?: boolean;
  onSetAllMetricsVisible?: (visible: boolean) => void;
};

const RunsMetricsLegend: React.FC<RunsMetricsLegendProps> = ({
  labelData,
  height,
  fullScreen,
  isRunMonitor,
  onSetAllMetricsVisible,
}) => {
  const { theme } = useDesignSystemTheme();
  const { formatMessage } = useIntl();
  const hasVisibleMetrics = labelData.some(({ checked }) => checked);
  const toggleAllLabel = hasVisibleMetrics
    ? formatMessage({
        defaultMessage: 'Hide all',
        description: 'Run monitor legend button to hide all metric series',
      })
    : formatMessage({
        defaultMessage: 'Show all',
        description: 'Run monitor legend button to show all metric series',
      });
  const labels = labelData.map((labelDatum) => (
    <TraceLabel
      key={`${labelDatum.uuid ?? ''}:${labelDatum.metricKey ?? labelDatum.label}`}
      {...labelDatum}
      isRunMonitor={isRunMonitor}
    />
  ));

  if (isRunMonitor) {
    return (
      <div
        css={{
          display: 'flex',
          flexDirection: 'column',
          height,
          minWidth: 0,
          gap: theme.spacing.sm,
          marginTop: fullScreen ? theme.spacing.lg : theme.spacing.sm,
        }}
      >
        {onSetAllMetricsVisible && (
          <div css={{ display: 'flex', alignItems: 'center', flexShrink: 0, height: 24 }}>
            <Button
              componentId="mlflow.run_monitor.toggle_all_metrics"
              type="link"
              size="small"
              aria-label={toggleAllLabel}
              aria-pressed={hasVisibleMetrics}
              title={toggleAllLabel}
              disabled={labelData.length === 0}
              onClick={() => onSetAllMetricsVisible(!hasVisibleMetrics)}
              css={{ '&&': { height: 24, padding: 0, border: 0 } }}
            >
              <span
                css={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: VISIBILITY_ICON_SIZE,
                  height: VISIBILITY_ICON_SIZE,
                  flexShrink: 0,
                  marginRight: theme.spacing.xs,
                  color: theme.colors.textSecondary,
                }}
              >
                {hasVisibleMetrics ? <Icon component={VisibleFillIcon} aria-hidden /> : <VisibleOffIcon aria-hidden />}
              </span>
              <Typography.Text color="secondary" size="sm">
                {toggleAllLabel}
              </Typography.Text>
            </Button>
          </div>
        )}
        <div
          css={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))',
            gridAutoRows: 24,
            alignContent: 'start',
            alignItems: 'center',
            columnGap: theme.spacing.md,
            rowGap: theme.spacing.xs,
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          {labels}
        </div>
      </div>
    );
  }

  return (
    <div
      css={{
        display: 'flex',
        flexWrap: 'wrap',
        height,
        alignContent: fullScreen ? 'flex-start' : 'normal',
        gap: fullScreen ? theme.spacing.sm : 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        marginTop: fullScreen ? theme.spacing.lg : theme.spacing.sm,
      }}
    >
      {labels}
    </div>
  );
};

export default RunsMetricsLegend;
