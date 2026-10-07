/**
 * Benchmark run controls: adapt run identities, then render visibility and baseline selection.
 * Naming: build* constructs native rows; toggle* changes the selected run visibility.
 */
import type { ColDef, ColumnResizedEvent } from '@ag-grid-community/core';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Button,
  SortAscendingIcon,
  SortDescendingIcon,
  TargetIcon,
  Tooltip,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { MLFlowAgGridLoader } from '../../../common/components/ag-grid/AgGridLoader';
import { useExperimentAgGridTableStyles } from '../../components/experiment-page/components/runs/ExperimentViewRunsTable';
import { ExperimentViewRunsTableHeaderContextProvider } from '../../components/experiment-page/components/runs/ExperimentViewRunsTableHeaderContext';
import {
  RowActionsCellRenderer,
  RowActionsCellRendererSuppressKeyboardEvents,
} from '../../components/experiment-page/components/runs/cells/RowActionsCellRenderer';
import { RowActionsHeaderCellRenderer } from '../../components/experiment-page/components/runs/cells/RowActionsHeaderCellRenderer';
import {
  RunNameCellRenderer,
  type RunNameCellRendererProps,
} from '../../components/experiment-page/components/runs/cells/RunNameCellRenderer';
import { RUNS_VISIBILITY_MODE } from '../../components/experiment-page/models/ExperimentPageUIState';
import { EXPERIMENT_RUNS_TABLE_ROW_HEIGHT } from '../../components/experiment-page/utils/experimentPage.common-utils';
import {
  type RunRowType,
  RunRowVisibilityControl,
} from '../../components/experiment-page/utils/experimentPage.row-types';
import { useRunsHighlightTableRow } from '../../components/runs-charts/hooks/useRunsHighlightTableRow';
import type { BenchmarkRun } from './benchmark.types';
import { BenchmarkHiddenRuns } from './BenchmarkHiddenRuns';

// ===== Native row adapter =====

type BenchmarkRunRow = RunRowType & { isBaseline: boolean };

const buildRunRow = (
  run: BenchmarkRun,
  experimentId: string,
  visibleRunIds: Set<string>,
  baselineRunId: string | null,
): BenchmarkRunRow => ({
  runUuid: run.run_id,
  rowUuid: run.run_id,
  runName: run.run_name || run.run_id,
  experimentId,
  duration: null,
  pinned: false,
  hidden: !visibleRunIds.has(run.run_id),
  pinnable: false,
  isBaseline: run.run_id === baselineRunId,
  visibilityControl: RunRowVisibilityControl.Enabled,
  models: null,
  datasets: [],
  // The native name cell uses only nesting fields; this list has no timing or status columns.
  runDateAndNestInfo: {
    startTime: 0,
    referenceTime: new Date(0),
    experimentId,
    runUuid: run.run_id,
    runStatus: '',
    isParent: false,
    hasExpander: false,
    belongsToGroup: false,
    level: 0,
  },
});

// ===== Native run controls =====

const BenchmarkRunNameCell = (
  props: RunNameCellRendererProps & {
    data: BenchmarkRunRow;
    onBaselineRunIdChange: (runId: string | null) => void;
  },
) => {
  const { runUuid, isBaseline } = props.data;
  const label = isBaseline ? 'Clear baseline' : 'Set as baseline';
  return (
    <div css={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: '100%', minWidth: 0 }}>
      <Tooltip componentId="mlflow.benchmarks.baseline.tooltip" content={label}>
        <Button
          componentId="mlflow.benchmarks.baseline.toggle"
          data-testid="benchmark-baseline-toggle"
          data-run-id={runUuid}
          aria-label={label}
          aria-pressed={isBaseline}
          type={isBaseline ? 'primary' : 'tertiary'}
          size="small"
          icon={<TargetIcon />}
          css={{ width: 24, minWidth: 24, height: 24, padding: 0, flexShrink: 0 }}
          onClick={(event) => {
            event.stopPropagation();
            props.onBaselineRunIdChange(isBaseline ? null : runUuid ?? null);
          }}
        />
      </Tooltip>
      <div css={{ minWidth: 0, flex: 1 }}>
        <RunNameCellRenderer {...props} />
      </div>
    </div>
  );
};

const BenchmarkRunHeader = ({
  sortDirection,
  onSort,
}: {
  sortDirection: 'asc' | 'desc' | 'none';
  onSort: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  return (
    <button
      type="button"
      aria-label="Sort by run number"
      data-testid="benchmark-run-sort"
      onClick={onSort}
      css={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.spacing.sm,
        width: '100%',
        height: '100%',
        border: 0,
        padding: 0,
        background: 'transparent',
        color: theme.colors.textPrimary,
        font: 'inherit',
        fontWeight: theme.typography.typographyBoldFontWeight,
        textAlign: 'left',
        cursor: 'pointer',
        svg: { color: sortDirection === 'none' ? theme.colors.textSecondary : theme.colors.textPrimary },
      }}
    >
      Run
      {sortDirection === 'desc' ? <SortDescendingIcon /> : <SortAscendingIcon />}
    </button>
  );
};

/** Renders the shared run column with visibility, baseline, and color controls. */
export const BenchmarkRunList = ({
  experimentId,
  runs,
  visibleRunIds,
  onVisibleRunIdsChange,
  sortDirection,
  onSort,
  width,
  onWidthChange,
  baselineRunId,
  onBaselineRunIdChange,
}: {
  experimentId: string;
  runs: BenchmarkRun[];
  visibleRunIds: string[];
  onVisibleRunIdsChange: (runIds: string[]) => void;
  sortDirection: 'asc' | 'desc' | 'none';
  onSort: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  baselineRunId: string | null;
  onBaselineRunIdChange: (runId: string | null) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const gridStyles = useExperimentAgGridTableStyles({ usingCustomHeaderComponent: false });
  const columnWidth = Math.max(180, width);
  const containerElement = useRef<HTMLDivElement>(null);
  const currentSelection = useRef({ runs, visibleRunIds, onVisibleRunIdsChange });
  useLayoutEffect(() => {
    currentSelection.current = { runs, visibleRunIds, onVisibleRunIdsChange };
  }, [runs, visibleRunIds, onVisibleRunIdsChange]);

  // Native memoized row cells keep one callback while selection changes elsewhere on the page.
  const toggleVisibility = useCallback((mode: string, runId?: string) => {
    const { runs: currentRuns, visibleRunIds: currentIds, onVisibleRunIdsChange: update } = currentSelection.current;
    const allIds = currentRuns.map((run) => run.run_id);
    if (mode === RUNS_VISIBILITY_MODE.CUSTOM && runId) {
      const selectedIds = new Set(currentIds);
      if (selectedIds.has(runId)) selectedIds.delete(runId);
      else selectedIds.add(runId);
      update(allIds.filter((id) => selectedIds.has(id)));
    } else if (mode === RUNS_VISIBILITY_MODE.HIDEALL) {
      update([]);
    } else if (mode === RUNS_VISIBILITY_MODE.FIRST_10_RUNS) {
      update(allIds.slice(0, 10));
    } else if (mode === RUNS_VISIBILITY_MODE.FIRST_20_RUNS) {
      update(allIds.slice(0, 20));
    } else if (mode === RUNS_VISIBILITY_MODE.SHOWALL) {
      update(allIds);
    }
  }, []);

  const restoreRun = useCallback((runId: string) => {
    const { runs: currentRuns, visibleRunIds: currentIds, onVisibleRunIdsChange: update } = currentSelection.current;
    const selectedIds = new Set(currentIds);
    selectedIds.add(runId);
    update(currentRuns.filter((run) => selectedIds.has(run.run_id)).map((run) => run.run_id));
  }, []);

  const hiddenRuns = useMemo(() => runs.filter((run) => !visibleRunIds.includes(run.run_id)), [runs, visibleRunIds]);

  const rows = useMemo(() => {
    const selectedIds = new Set(visibleRunIds);
    return runs
      .filter((run) => selectedIds.has(run.run_id))
      .map((run) => buildRunRow(run, experimentId, selectedIds, baselineRunId));
  }, [runs, experimentId, visibleRunIds, baselineRunId]);

  const updateWidth = useCallback(
    ({ column, source }: ColumnResizedEvent) => {
      // Only native drag and autosize events may update the shared comparison width.
      if ((source === 'uiColumnDragged' || source === 'uiColumnResized') && column?.getColId() === 'runName') {
        onWidthChange(Math.max(180, column.getActualWidth() + 41));
      }
    },
    [onWidthChange],
  );

  const columnDefinitions = useMemo<ColDef[]>(
    () => [
      {
        colId: 'visibility',
        headerName: '',
        width: 40,
        minWidth: 40,
        maxWidth: 40,
        headerComponent: RowActionsHeaderCellRenderer,
        headerComponentParams: {
          onToggleVisibility: toggleVisibility,
          children: <BenchmarkHiddenRuns hiddenRuns={hiddenRuns} onRestoreRun={restoreRun} />,
        },
        valueGetter: ({ data }: { data: RunRowType }) => ({ hidden: data.hidden, pinned: false }),
        cellRenderer: RowActionsCellRenderer,
        cellRendererParams: { onToggleVisibility: toggleVisibility, onTogglePin: () => undefined },
        cellClass: 'is-checkbox-cell',
        suppressKeyboardEvent: RowActionsCellRendererSuppressKeyboardEvents,
      },
      {
        colId: 'runName',
        valueGetter: ({ data }: { data: RunRowType }) => data,
        headerName: 'Run',
        headerComponent: BenchmarkRunHeader,
        headerComponentParams: { sortDirection, onSort },
        width: columnWidth - 41,
        minWidth: 139,
        resizable: true,
        cellRenderer: BenchmarkRunNameCell,
        cellRendererParams: { isComparingRuns: true, onExpand: () => undefined, onBaselineRunIdChange },
        suppressKeyboardEvent: ({ event }) =>
          (event.key === 'Enter' || event.key === ' ') &&
          event.target instanceof HTMLElement &&
          Boolean(event.target.closest('[data-testid="benchmark-baseline-toggle"]')),
      },
    ],
    [toggleVisibility, hiddenRuns, restoreRun, sortDirection, onSort, columnWidth, onBaselineRunIdChange],
  );

  const allRunsHidden = rows.length === 0;
  const allRunsVisible = rows.length === runs.length;
  const visibilityMode = allRunsHidden
    ? RUNS_VISIBILITY_MODE.HIDEALL
    : allRunsVisible
    ? RUNS_VISIBILITY_MODE.SHOWALL
    : RUNS_VISIBILITY_MODE.CUSTOM;
  const { cellMouseOverHandler, cellMouseOutHandler } = useRunsHighlightTableRow(containerElement);

  return (
    <aside
      aria-label="Visible runs"
      css={{
        width: columnWidth,
        minWidth: columnWidth,
        maxWidth: columnWidth,
        flex: `0 0 ${columnWidth}px`,
        alignSelf: 'stretch',
        boxSizing: 'border-box',
        position: 'sticky',
        left: 0,
        zIndex: 2,
        backgroundColor: theme.colors.backgroundPrimary,
        borderRight: `1px solid ${theme.colors.border}`,
      }}
    >
      <ExperimentViewRunsTableHeaderContextProvider
        runsHiddenMode={visibilityMode}
        usingCustomVisibility={visibilityMode === RUNS_VISIBILITY_MODE.CUSTOM}
        useGroupedValuesInCharts={false}
        allRunsHidden={allRunsHidden}
      >
        <div
          ref={containerElement}
          className="ag-theme-balham is-table-comparing-runs-mode"
          css={[
            gridStyles,
            {
              height: 'auto',
              minHeight: 0,
              minWidth: 0,
              '&.ag-theme-balham': {
                '.ag-root-wrapper, .ag-root': { border: 0, borderRadius: 0, overflow: 'visible' },
                '.ag-root-wrapper-body': { minHeight: 0 },
                '.ag-layout-auto-height .ag-center-cols-clipper, .ag-layout-auto-height .ag-center-cols-container': {
                  minHeight: 0,
                },
                '.ag-body-viewport': { overflowY: 'visible' },
                '.ag-body-horizontal-scroll, .ag-body-vertical-scroll': { display: 'none' },
                '.ag-header': {
                  // AG Grid adds a border pixel to headerHeight; include it within the shared 48px header.
                  height: '48px !important',
                  minHeight: '48px !important',
                  maxHeight: 48,
                  boxSizing: 'border-box',
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                },
                '.ag-header::after': { display: 'none' },
                '.ag-header-cell[col-id="visibility"]': { padding: 0 },
                '.ag-header-cell[col-id="runName"] .ag-react-container': { width: '100%', height: '100%' },
                // Keep the complete native drag target inside the clipped final column.
                '.ag-header-cell[col-id="runName"] .ag-header-cell-resize': { right: 0, width: 8 },
                '.ag-row.benchmark-baseline-row, .ag-row.benchmark-baseline-row.ag-row-hover': {
                  backgroundColor: theme.colors.tableBackgroundSelectedDefault,
                },
              },
            },
          ]}
        >
          <MLFlowAgGridLoader
            rowData={rows}
            columnDefs={columnDefinitions}
            defaultColDef={{ sortable: false, resizable: false, suppressMenu: true, suppressMovable: true }}
            getRowId={({ data }) => data.rowUuid}
            rowClassRules={{ 'benchmark-baseline-row': ({ data }) => Boolean(data?.isBaseline) }}
            domLayout="autoHeight"
            rowHeight={EXPERIMENT_RUNS_TABLE_ROW_HEIGHT}
            headerHeight={48}
            suppressRowClickSelection
            suppressColumnMoveAnimation
            suppressScrollOnNewData
            suppressNoRowsOverlay
            enableCellTextSelection
            onCellMouseOver={cellMouseOverHandler}
            onCellMouseOut={cellMouseOutHandler}
            onColumnResized={updateWidth}
          />
        </div>
      </ExperimentViewRunsTableHeaderContextProvider>
    </aside>
  );
};
