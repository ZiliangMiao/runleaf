/**
 * Lineage canvas: display formatting, then camera controls and card rendering.
 * Naming: format_* produces labels; handle_* responds to pointer interactions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Button, useDesignSystemTheme } from '@databricks/design-system';
import { Link } from '../../../common/utils/RoutingUtils';
import Routes from '../../routes';
import { getUUID } from '../../../common/utils/ActionUtils';
import { LINEAGE_CARD, formatComparison, formatDifference, formatMetric } from './lineageGraph';
import type { LineageLayout } from './lineageGraph';

// ===== Display formatting =====

const formatLines = (value: string, width = 36): string[] =>
  value.length <= width
    ? [value]
    : [
        value.slice(0, width),
        value.length > width * 2 ? `${value.slice(width, width * 2 - 3)}...` : value.slice(width),
      ];

// ===== Camera controls and card rendering =====

/** Render run cards with explicit zoom, pointer panning and click navigation. */
export const ExperimentLineageGraph = ({ layout, metricKey }: { layout: LineageLayout; metricKey: string }) => {
  const { theme } = useDesignSystemTheme();
  const viewport = useRef<HTMLDivElement>(null);
  const followsFit = useRef(true);
  const suppressClick = useRef(false);
  const pointer = useRef<{
    identity: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const [arrowId] = useState(() => `lineage-arrow-${getUUID()}`);
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const fit = useCallback(() => {
    const element = viewport.current;
    if (!element || !element.clientWidth || !element.clientHeight) return;
    const zoom = Math.min(
      1,
      Math.max(1, element.clientWidth - 32) / layout.width,
      Math.max(1, element.clientHeight - 32) / layout.height,
    );
    followsFit.current = true;
    setCamera({
      zoom,
      x: (element.clientWidth - layout.width * zoom) / 2,
      y: (element.clientHeight - layout.height * zoom) / 2,
    });
  }, [layout.width, layout.height]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    fit();
    // Preserve a user's camera when browser scrollbars or the window resize.
    const observer = new ResizeObserver(() => {
      if (followsFit.current) fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  const zoomBy = (factor: number) => {
    const element = viewport.current;
    if (!element) return;
    followsFit.current = false;
    const centerX = element.clientWidth / 2;
    const centerY = element.clientHeight / 2;
    setCamera((current) => {
      const zoom = Math.min(3, Math.max(0.001, current.zoom * factor));
      const ratio = zoom / current.zoom;
      return { zoom, x: centerX - (centerX - current.x) * ratio, y: centerY - (centerY - current.y) * ratio };
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    pointer.current = {
      identity: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: camera.x,
      originY: camera.y,
      moved: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.identity !== event.pointerId) return;
    const distanceX = event.clientX - active.startX;
    const distanceY = event.clientY - active.startY;
    if (!active.moved && Math.hypot(distanceX, distanceY) < 4) return;
    if (!active.moved) {
      active.moved = true;
      followsFit.current = false;
      suppressClick.current = true;
      // Capture only after movement so ordinary clicks still reach run links.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.preventDefault();
    setCamera((current) => ({ ...current, x: active.originX + distanceX, y: active.originY + distanceY }));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.identity !== event.pointerId) return;
    pointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div css={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 240, minWidth: 0, gap: 8 }}>
      <div css={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button componentId="mlflow.lineage.zoom_out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          -
        </Button>
        <span aria-label="Zoom level">{Math.round(camera.zoom * 100)}%</span>
        <Button componentId="mlflow.lineage.zoom_in" aria-label="Zoom in" onClick={() => zoomBy(1.3)}>
          +
        </Button>
        <Button componentId="mlflow.lineage.fit" onClick={fit}>
          Fit graph
        </Button>
        <span css={{ color: theme.colors.textSecondary, marginLeft: 8 }}>
          Drag to pan. Select a run to open it. Dashed cards: external parents.
        </span>
      </div>
      <div
        ref={viewport}
        data-testid="lineage-viewport"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={() => {
          pointer.current = null;
          setDragging(false);
        }}
        onPointerLeave={() => {
          if (!pointer.current?.moved) pointer.current = null;
        }}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
        css={{
          flex: 1,
          minHeight: 200,
          minWidth: 0,
          position: 'relative',
          overflow: 'hidden',
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          border: `1px solid ${theme.colors.border}`,
          borderRadius: 8,
          background: theme.colors.backgroundPrimary,
        }}
      >
        <svg
          role="img"
          aria-label="Run lineage graph"
          width="100%"
          height="100%"
          css={{ position: 'absolute', inset: 0, display: 'block' }}
        >
          <title>Run lineage graph</title>
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#68788a" />
            </marker>
          </defs>
          <g data-testid="lineage-camera" transform={`translate(${camera.x},${camera.y}) scale(${camera.zoom})`}>
            {layout.groups.map((group) => (
              <g key={group.experimentId}>
                <rect
                  x={group.x - group.width / 2}
                  y={group.y - group.height / 2}
                  width={group.width}
                  height={group.height}
                  rx={12}
                  fill="#f7f9fc"
                  stroke="#ced8e3"
                />
                <text
                  x={group.x - group.width / 2 + 14}
                  y={group.y - group.height / 2 + 23}
                  fill="#33465b"
                  fontSize={14}
                  fontWeight={600}
                >
                  {group.name}
                </text>
              </g>
            ))}
            {layout.edges.map((edge) => (
              <g key={`${edge.source}:${edge.target}`} data-testid="lineage-edge">
                <title>{edge.change}</title>
                <polyline
                  points={edge.points.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill="none"
                  stroke="#68788a"
                  strokeWidth={1.5}
                  markerEnd={`url(#${arrowId})`}
                />
                {edge.change && (
                  <text
                    x={edge.x}
                    y={edge.y - 6}
                    textAnchor="middle"
                    fill="#34465b"
                    fontSize={12}
                    stroke="#ffffff"
                    strokeWidth={4}
                    paintOrder="stroke"
                  >
                    {formatLines(edge.change).map((line, index) => (
                      <tspan key={index} x={edge.x} dy={index ? 16 : 0}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )}
              </g>
            ))}
            {layout.nodes.map((node) => {
              const color = node.isExternal ? '#788594' : node.isRoot ? '#25824b' : '#3577b8';
              const left = -node.width / 2 + LINEAGE_CARD.padding;
              const top = -node.height / 2;
              const content = (
                <>
                  <title>
                    {[
                      node.runName,
                      node.runId,
                      node.experimentName,
                      `Model: ${node.modelName ?? '--'}`,
                      `Change: ${node.change ?? '--'}`,
                      `Dataset: ${node.datasetVersion ?? '--'}`,
                      `${metricKey}: ${formatMetric(node.metric)}`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  </title>
                  <rect
                    x={-node.width / 2}
                    y={top}
                    width={node.width}
                    height={node.height}
                    rx={8}
                    fill={node.isExternal ? '#f3f5f7' : node.isRoot ? '#eff9f1' : '#ffffff'}
                    stroke={color}
                    strokeWidth={1.5}
                    strokeDasharray={node.isExternal ? '5 4' : undefined}
                  />
                  <rect x={-node.width / 2} y={top + 10} width={4} height={node.height - 20} rx={2} fill={color} />
                  <text
                    data-testid="lineage-run-sequence"
                    x={node.width / 2 - LINEAGE_CARD.padding}
                    y={top + 20}
                    textAnchor="end"
                    fill={color}
                    fontWeight={700}
                  >
                    {node.runSequence ?? '--'}
                  </text>
                  {(
                    [
                      ['Model', node.modelName],
                      ['Change', node.change],
                      ['Dataset', node.datasetVersion],
                    ] as const
                  ).map(([label, value], index) => (
                    <text
                      key={label}
                      data-testid={`lineage-field-${label.toLowerCase()}`}
                      x={left}
                      y={top + LINEAGE_CARD.firstRow + index * LINEAGE_CARD.rowSpacing}
                      fill="#172c41"
                    >
                      <tspan fill="#65758a">{label}:</tspan>
                      <tspan x={left + LINEAGE_CARD.valueOffset}>{value || '--'}</tspan>
                    </text>
                  ))}
                  <text
                    data-testid="lineage-metric-value"
                    x={left}
                    y={top + LINEAGE_CARD.firstRow + 3 * LINEAGE_CARD.rowSpacing}
                    fill="#172c41"
                  >
                    <tspan fill="#65758a">Metric:</tspan>
                    <tspan x={left + LINEAGE_CARD.valueOffset}>{formatMetric(node.metric)}</tspan>
                    {node.metricComparisons.map((comparison) => (
                      <tspan
                        key={comparison.baseRunId}
                        data-testid="lineage-metric-difference"
                        data-base-run-id={comparison.baseRunId}
                        dx={LINEAGE_CARD.differenceSpacing}
                        fill={
                          comparison.difference === undefined || comparison.difference === 0
                            ? '#65758a'
                            : comparison.difference > 0
                            ? '#c62828'
                            : '#15803d'
                        }
                      >
                        <title>{`Compared with ${comparison.baseRunSequence ?? comparison.baseRunId}: ${
                          comparison.difference === undefined
                            ? 'Metric unavailable for current run or base run'
                            : formatDifference(comparison.difference)
                        }`}</title>
                        {formatComparison(comparison, node.metricComparisons.length > 1)}
                      </tspan>
                    ))}
                  </text>
                </>
              );
              return (
                <g
                  key={node.runId}
                  data-testid="lineage-node"
                  data-run-id={node.runId}
                  data-external={node.isExternal}
                  fontFamily={LINEAGE_CARD.fontFamily}
                  fontSize={LINEAGE_CARD.fontSize}
                  transform={`translate(${node.x},${node.y})`}
                >
                  {node.experimentId ? (
                    <Link
                      to={Routes.getRunPageRoute(node.experimentId, node.runId)}
                      aria-label={`Open run ${node.runName}`}
                      css={{ cursor: dragging ? 'grabbing' : 'pointer' }}
                    >
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
};
