/**
 * Experiment lineage page: paginated queries, then page controls and state.
 * Naming: fetch_* reads MLflow APIs; build_* constructs graph data.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, LegacySelect, Spinner, useDesignSystemTheme } from '@databricks/design-system';
import { MlflowService } from '../../sdk/MlflowService';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import type { ExperimentEntity, RunEntity } from '../../types';
import { buildLineageGraph, buildLineageLayout } from './lineageGraph';
import { ExperimentLineageGraph } from './ExperimentLineageGraph';

// ===== Paginated queries =====

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

const fetchRuns = async (experimentIds: string[]): Promise<{ runs: RunEntity[]; baseRuns: RunEntity[] }> => {
  const runs: RunEntity[] = [];
  let pageToken: string | undefined;
  do {
    const page = await MlflowService.searchRuns({
      experiment_ids: experimentIds,
      max_results: 1000,
      run_view_type: 'ACTIVE_ONLY',
      order_by: ['attributes.start_time ASC'],
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    runs.push(...(page.runs ?? []));
    pageToken = page.next_page_token;
  } while (pageToken);
  const selectedRunIds = new Set(runs.map((run) => run.info.runUuid));
  const parentRunIds = new Set(
    runs.flatMap((run) =>
      (run.data.tags?.find((tag) => tag.key === 'base_run_id')?.value ?? '')
        .split(',')
        .map((runId) => runId.trim())
        .filter((runId) => runId && runId.toLowerCase() !== 'none' && !selectedRunIds.has(runId)),
    ),
  );
  const parentRuns = await Promise.all(
    [...parentRunIds].map(async (runId): Promise<RunEntity | undefined> => {
      try {
        const response = await MlflowService.getRun({ run_id: runId });
        return response?.run ?? undefined;
      } catch {
        // Unreadable parents keep their placeholders without hiding the selected runs.
        return undefined;
      }
    }),
  );
  return { runs, baseRuns: parentRuns.filter((run): run is RunEntity => run !== undefined) };
};

// ===== Page controls and state =====

/** Display the current experiment's lineage with optional cross-experiment parents. */
const ExperimentLineagePage = ({ experimentId }: { experimentId: string }) => {
  const { theme } = useDesignSystemTheme();
  const [experimentIds, setExperimentIds] = useState([experimentId]);
  const [metricKey, setMetricKey] = useState('val/best_ap');
  const experiments = useQuery(['lineage-experiments'], fetchExperiments, { refetchOnWindowFocus: false });
  const runs = useQuery(['lineage-runs', [...experimentIds].sort()], () => fetchRuns(experimentIds), {
    enabled: experimentIds.length > 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const metricKeys = useMemo(
    () =>
      [
        ...new Set([
          metricKey,
          ...(runs.data?.runs ?? []).flatMap((run) => (run.data.metrics ?? []).map((metric) => metric.key)),
        ]),
      ].sort(),
    [runs.data, metricKey],
  );
  const graph = useMemo(() => {
    try {
      const lineage = buildLineageGraph(
        runs.data?.runs ?? [],
        experiments.data ?? [],
        metricKey,
        runs.data?.baseRuns ?? [],
      );
      return { lineage, layout: lineage.nodes.length ? buildLineageLayout(lineage) : undefined };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [runs.data, experiments.data, metricKey]);
  const loading = runs.isFetching || experiments.isFetching;
  const error = runs.error || experiments.error;
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
        <div css={{ flex: 1, minWidth: 240 }}>
          <label htmlFor="lineage-metric" css={{ display: 'block', marginBottom: 4 }}>
            Node metric
          </label>
          <LegacySelect
            id="lineage-metric"
            aria-label="Lineage metric"
            dangerouslySetAntdProps={{ showSearch: true }}
            optionFilterProp="label"
            value={metricKey}
            onChange={(value: string) => setMetricKey(value)}
            options={metricKeys.map((key) => ({ value: key, label: key }))}
            css={{ width: '100%' }}
          />
        </div>
        <Button
          componentId="mlflow.lineage.refresh"
          disabled={loading || !experimentIds.length}
          onClick={() => {
            experiments.refetch();
            runs.refetch();
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
        {missingMetrics > 0 && ` | ${missingMetrics} runs have no value for ${metricKey}`}
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
          <ExperimentLineageGraph layout={graph.layout} metricKey={metricKey} />
        ))}
    </section>
  );
};

export default ExperimentLineagePage;
