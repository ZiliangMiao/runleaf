/**
 * Hidden run labels and restore items for the native visibility menu.
 * Naming: build* constructs display labels from run identities.
 */
import { DropdownMenu, VisibleOffIcon, useDesignSystemTheme } from '@databricks/design-system';
import type { BenchmarkRun } from './benchmark.types';

// ===== Run labels =====

const buildRunName = (run: BenchmarkRun): string => run.run_name || run.run_id;

// ===== Restore menu =====

/** Adds individually restorable runs to the native visibility menu using exact run IDs. */
export const BenchmarkHiddenRuns = ({
  hiddenRuns,
  onRestoreRun,
}: {
  hiddenRuns: BenchmarkRun[];
  onRestoreRun: (runId: string) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  if (hiddenRuns.length === 0) return null;

  // Match the native radio item's indicator slot and horizontal padding.
  const menuTextPadding = theme.general.iconFontSize + theme.spacing.xs + theme.spacing.sm * 2;
  const nameCounts = new Map<string, number>();
  hiddenRuns.forEach((run) => {
    const name = buildRunName(run);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  });

  return (
    <>
      <DropdownMenu.Separator />
      <DropdownMenu.Label css={{ paddingLeft: menuTextPadding, color: theme.colors.textPrimary }}>
        Hidden runs ({hiddenRuns.length})
      </DropdownMenu.Label>
      <DropdownMenu.Group
        aria-label="Hidden runs"
        css={{
          maxHeight: 'min(240px, max(0px, calc(100vh - 240px)))',
          maxWidth: 'min(360px, calc(100vw - 24px))',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {hiddenRuns.map((run) => {
          const name = buildRunName(run);
          const number = run.run_num === null ? run.run_id : `r${String(run.run_num).padStart(2, '0')}`;
          const label = (nameCounts.get(name) ?? 0) > 1 ? `${name} (${number})` : name;
          return (
            <DropdownMenu.Item
              key={run.run_id}
              componentId="mlflow.benchmarks.restore_run"
              onClick={() => onRestoreRun(run.run_id)}
              title={label}
              css={{
                paddingLeft: menuTextPadding + theme.spacing.md,
                flexWrap: 'nowrap',
                gap: theme.spacing.sm,
              }}
            >
              <VisibleOffIcon
                aria-hidden="true"
                css={{ width: theme.general.iconFontSize, flexShrink: 0, color: theme.colors.textSecondary }}
              />
              <span css={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
              </span>
            </DropdownMenu.Item>
          );
        })}
      </DropdownMenu.Group>
    </>
  );
};
