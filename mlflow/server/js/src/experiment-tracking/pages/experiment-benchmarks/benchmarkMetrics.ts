/**
 * Metric values and baseline differences shared by benchmark tables and charts.
 * Naming: build* derives numeric values and their display labels.
 */
import type { BenchmarkColumn } from './benchmark.types';

// ===== Metric values =====

/** Reads a finite metric value for the selected benchmark version and run. */
export const buildMetricValue = (column: BenchmarkColumn, runId: string | null): number | null => {
  const value = runId ? column.evaluations.get(runId)?.metrics[column.metric] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

// ===== Baseline differences =====

/** Subtracts recorded values before rounding the displayed difference. */
export const buildMetricDifference = (value: number | null, baselineValue: number | null): number | null => {
  if (value === null || baselineValue === null) return null;
  const difference = value - baselineValue;
  return Number.isFinite(difference) ? Number(difference.toFixed(3)) : null;
};

/** Formats signed differences, including rounded zero, with three decimal places. */
export const buildMetricDifferenceLabel = (difference: number): string =>
  `${difference >= 0 ? '+' : ''}${difference.toFixed(3)}`;
