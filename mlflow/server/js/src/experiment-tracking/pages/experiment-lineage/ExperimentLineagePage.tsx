/**
 * Experiment lineage page: queries, benchmark selections, then page controls and state.
 * Naming: fetch* reads MLflow APIs; build* constructs selections and graph data.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, LegacySelect, Spinner, useDesignSystemTheme } from '@databricks/design-system';
import { MlflowService } from '../../sdk/MlflowService';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import { getJson } from '../../../common/utils/FetchUtils';
import type { ExperimentEntity, RunEntity } from '../../types';
import type { BenchmarkGroup, ExperimentBenchmarks } from '../experiment-benchmarks/benchmark.types';
import { buildExperimentProject, buildLineageGraph, buildLineageLayout } from './lineageGraph';
import { ExperimentLineageGraph } from './ExperimentLineageGraph';

// ===== Queries =====

const fetchExperiments = async (): Promise<ExperimentEntity[]> => {
  const experiments: ExperimentEntity[] = [];
  let pageToken: string | undefined;
  do {
    const page: { experiments?: ExperimentEntity[]; next_page_token?: string } = await MlflowService.searchExperiments({
      max_results: 1000,
      view_type: 'ACTIVE_ONLY',
      order_by: ['name ASC'],
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    experiments.push(...(page.experiments ?? []));
    pageToken = page.next_page_token;
  } while (pageToken);
  return experiments;
};

const fetchRuns = async (
  experimentIds: string[],
  projectExperimentIds: string[],
): Promise<{ runs: RunEntity[]; baseRuns: RunEntity[] }> => {
  const runs: RunEntity[] = [];
  let pageToken: string | undefined;
  do {
    const page = await MlflowService.searchRuns({
      experiment_ids: projectExperimentIds,
      max_results: 1000,
      run_view_type: 'ACTIVE_ONLY',
      order_by: ['attributes.start_time ASC'],
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    runs.push(...(page.runs ?? []));
    pageToken = page.next_page_token;
  } while (pageToken);
  const selectedExperiments = new Set(experimentIds);
  return {
    runs: runs.filter((run) => selectedExperiments.has(run.info.experimentId)),
    baseRuns: runs.filter((run) => !selectedExperiments.has(run.info.experimentId)),
  };
};

const fetchBenchmarks = (experimentIds: string[]): Promise<ExperimentBenchmarks[]> =>
  Promise.all(
    experimentIds.map(
      (experimentId) =>
        getJson({
          relativeUrl: `ajax-api/2.0/deeplore/experiments/${encodeURIComponent(experimentId)}/benchmarks`,
        }) as Promise<ExperimentBenchmarks>,
    ),
  );

// ===== Benchmark selections =====

const buildBenchmarkGroups = (responses: ExperimentBenchmarks[]): BenchmarkGroup[] => {
  const groups = new Map<string, BenchmarkGroup>();
  for (const response of responses) {
    for (const group of response.benchmarks) {
      if (!group.first_dataset_version) continue;
      const key = JSON.stringify([group.dataset_name, group.test_hash]);
      const existing = groups.get(key);
      groups.set(key, {
        ...group,
        metric_names: [...new Set([...(existing?.metric_names ?? []), ...group.metric_names])].sort(),
        evaluations: [...(existing?.evaluations ?? []), ...group.evaluations],
      });
    }
  }
  return [...groups.values()];
};

// ===== Page controls and state =====

/** Display the current experiment's lineage with optional cross-experiment parents. */
const ExperimentLineagePage = ({ experimentId }: { experimentId: string }) => {
  const { theme } = useDesignSystemTheme();
  const [experimentIds, setExperimentIds] = useState([experimentId]);
  const [selectedBenchmark, setSelectedBenchmark] = useState<string>();
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [selectedMetric, setSelectedMetric] = useState<string>();
  const experiments = useQuery(['lineage-experiments'], fetchExperiments, { refetchOnWindowFocus: false });
  const projectExperimentIds = useMemo(() => {
    const projects = new Set(
      (experiments.data ?? [])
        .filter((experiment) => experimentIds.includes(experiment.experimentId))
        .map((experiment) => buildExperimentProject(experiment.name))
        .filter((project): project is string => Boolean(project)),
    );
    return [
      ...new Set([
        ...experimentIds,
        ...(experiments.data ?? [])
          .filter((experiment) => projects.has(buildExperimentProject(experiment.name) ?? ''))
          .map((experiment) => experiment.experimentId),
      ]),
    ].sort();
  }, [experiments.data, experimentIds]);
  const runs = useQuery(
    ['lineage-runs', [...experimentIds].sort(), projectExperimentIds],
    () => fetchRuns(experimentIds, projectExperimentIds),
    {
      enabled: experimentIds.length > 0 && experiments.isSuccess,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const benchmarks = useQuery(
    ['lineage-benchmarks', projectExperimentIds],
    () => fetchBenchmarks(projectExperimentIds),
    {
      enabled: experimentIds.length > 0 && experiments.isSuccess,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const groups = useMemo(() => buildBenchmarkGroups(benchmarks.data ?? []), [benchmarks.data]);
  const benchmarkNames = [...new Set(groups.map((group) => group.dataset_name))].sort();
  const benchmarkName =
    selectedBenchmark && benchmarkNames.includes(selectedBenchmark)
      ? selectedBenchmark
      : benchmarkNames.find((name) =>
          groups.some((group) => group.dataset_name === name && group.evaluations.length),
        ) ?? benchmarkNames[0];
  const versions = groups
    .filter((group) => group.dataset_name === benchmarkName)
    .sort((left, right) =>
      (left.first_dataset_version ?? '').localeCompare(right.first_dataset_version ?? '', undefined, { numeric: true }),
    );
  const version =
    versions.find((group) => group.test_hash === selectedVersion) ??
    [...versions].sort(
      (left, right) =>
        Number(right.evaluations.length > 0) - Number(left.evaluations.length > 0) ||
        (right.first_dataset_version ?? '').localeCompare(left.first_dataset_version ?? '', undefined, {
          numeric: true,
        }),
    )[0];
  const metricKeys = version?.metric_names ?? [];
  const metricKey =
    selectedMetric && metricKeys.includes(selectedMetric)
      ? selectedMetric
      : metricKeys.find((key) =>
          version?.evaluations.some((evaluation) => {
            const value = evaluation.metrics[key];
            return typeof value === 'number' && Number.isFinite(value);
          }),
        ) ?? metricKeys[0];
  const metricValues = useMemo(
    () =>
      new Map(
        (version?.evaluations ?? []).flatMap((evaluation) => {
          const value = evaluation.metrics[metricKey];
          return typeof value === 'number' && Number.isFinite(value) ? [[evaluation.run_id, value] as const] : [];
        }),
      ),
    [version, metricKey],
  );
  const graph = useMemo(() => {
    try {
      const lineage = buildLineageGraph(
        runs.data?.runs ?? [],
        experiments.data ?? [],
        metricValues,
        runs.data?.baseRuns ?? [],
      );
      return { lineage, layout: lineage.nodes.length ? buildLineageLayout(lineage) : undefined };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [runs.data, experiments.data, metricValues]);
  const loading = runs.isFetching || experiments.isFetching || benchmarks.isFetching;
  const error = runs.error || experiments.error || benchmarks.error;
  const errorMessage = error
    ? error instanceof ErrorWrapper
      ? error.getMessageField()
      : error instanceof Error
      ? error.message
      : String(error)
    : graph.error;
  const missingMetrics =
    graph.lineage?.nodes.filter((node) => !node.isExternal && node.metric === undefined).length ?? 0;

  return (
    <section
      aria-label="Run lineage"
      css={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 12 }}
    >
      <div css={{ display: 'flex', gap: 16, alignItems: 'end', flexWrap: 'wrap' }}>
        <div css={{ flex: 1, minWidth: 260 }}>
          <label htmlFor="lineage-experiments" css={{ display: 'block', marginBottom: 4 }}>
            Experiments
          </label>
          <LegacySelect
            id="lineage-experiments"
            aria-label="Lineage experiments"
            mode="multiple"
            value={experimentIds}
            onChange={(values: string[]) => setExperimentIds(values)}
            options={(experiments.data ?? []).map((experiment) => ({
              value: experiment.experimentId,
              label: experiment.name,
            }))}
            optionFilterProp="label"
            css={{ width: '100%' }}
          />
        </div>
        <div css={{ flex: 1, minWidth: 220 }}>
          <label htmlFor="lineage-benchmark" css={{ display: 'block', marginBottom: 4 }}>
            Benchmark
          </label>
          <LegacySelect
            id="lineage-benchmark"
            aria-label="Lineage benchmark"
            dangerouslySetAntdProps={{ showSearch: true }}
            optionFilterProp="label"
            value={benchmarkName}
            onChange={(value: string) => {
              setSelectedBenchmark(value);
              setSelectedVersion(undefined);
              setSelectedMetric(undefined);
            }}
            options={benchmarkNames.map((name) => ({ value: name, label: name }))}
            placeholder="No benchmarks available"
            disabled={!benchmarkNames.length}
            css={{ width: '100%' }}
          />
        </div>
        <div css={{ minWidth: 150 }}>
          <label htmlFor="lineage-version" css={{ display: 'block', marginBottom: 4 }}>
            Version
          </label>
          <LegacySelect
            id="lineage-version"
            aria-label="Lineage version"
            value={version?.test_hash}
            onChange={(value: string) => {
              setSelectedVersion(value);
              setSelectedMetric(undefined);
            }}
            options={versions.map((group) => ({ value: group.test_hash, label: group.first_dataset_version }))}
            placeholder="No versions available"
            disabled={!versions.length}
            css={{ width: '100%' }}
          />
        </div>
        <div css={{ flex: 1, minWidth: 180 }}>
          <label htmlFor="lineage-metric" css={{ display: 'block', marginBottom: 4 }}>
            Metric
          </label>
          <LegacySelect
            id="lineage-metric"
            aria-label="Lineage metric"
            dangerouslySetAntdProps={{ showSearch: true }}
            optionFilterProp="label"
            value={metricKey}
            onChange={(value: string) => setSelectedMetric(value)}
            options={metricKeys.map((key) => ({ value: key, label: key }))}
            placeholder="No metrics available"
            disabled={!metricKeys.length}
            css={{ width: '100%' }}
          />
        </div>
        <Button
          componentId="mlflow.lineage.refresh"
          disabled={loading || !experimentIds.length}
          onClick={() => {
            experiments.refetch();
            runs.refetch();
            benchmarks.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      <div css={{ color: theme.colors.textSecondary }}>
        {graph.lineage
          ? `${graph.lineage.nodes.filter((node) => !node.isExternal).length} runs, ${
              graph.lineage.edges.length
            } relationships`
          : 'Run lineage'}
        {metricKey && missingMetrics > 0 && ` | ${missingMetrics} runs have no value for ${metricKey}`}
      </div>
      {errorMessage && (
        <Alert
          componentId="mlflow.lineage.error"
          type="error"
          message="Unable to load lineage"
          description={errorMessage}
        />
      )}
      {loading && (
        <div role="status" css={{ padding: 24 }}>
          <Spinner /> Loading lineage...
        </div>
      )}
      {!loading &&
        !errorMessage &&
        (!experimentIds.length ? (
          <p>Select at least one experiment.</p>
        ) : !graph.layout ? (
          <p>No active runs in the selected experiments.</p>
        ) : (
          <ExperimentLineageGraph layout={graph.layout} metricKey={metricKey ?? 'Metric'} />
        ))}
    </section>
  );
};

export default ExperimentLineagePage;
