/** Database benchmark results shared by the comparison table and native chart adapters. */

// ===== API response =====

export interface BenchmarkRun {
  run_id: string;
  run_name: string;
  run_num: number | null;
}

export interface BenchmarkEvaluation {
  evaluation_id: string;
  run_id: string;
  evaluation_time: number | null;
  metrics: Record<string, number | null>;
}

export interface BenchmarkGroup {
  dataset_name: string;
  test_hash: string;
  dataset_versions: string[];
  first_dataset_version: string | null;
  metric_names: string[];
  evaluations: BenchmarkEvaluation[];
}

export interface ExperimentBenchmarks {
  experiment_id: string;
  runs: BenchmarkRun[];
  benchmarks: BenchmarkGroup[];
}

// ===== Selected comparison =====

export interface BenchmarkColumn {
  key: string;
  group: BenchmarkGroup;
  metric: string;
  evaluations: Map<string, BenchmarkEvaluation>;
}
