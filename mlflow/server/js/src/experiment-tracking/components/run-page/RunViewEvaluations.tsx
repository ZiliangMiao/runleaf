/**
 * Run evaluations: response types and requests, shared fields, evaluation records, then the run tab.
 * Naming: fetch* reads the server; format* prepares display values; components describe their content.
 */
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Empty,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tag,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import { getJson } from '../../../common/utils/FetchUtils';
import { Link } from '../../../common/utils/RoutingUtils';
import Routes from '../../routes';

// ===== Response types and requests =====

interface RunEvaluation {
  evaluation_id: string;
  run_id: string;
  association_status: 'confirmed' | 'pending';
  dataset_name: string | null;
  dataset_version: string | null;
  benchmark_name: string | null;
  test_hash: string | null;
  ckpt_path: string | null;
  ckpt_hash: string | null;
  ckpt_hash_algorithm: string | null;
  evaluated_at: number | null;
  metrics: Record<string, number | null>;
  artifact_path: string | null;
  source_artifact: string | null;
  source_row: number | null;
  metadata: Record<string, unknown> & { incomplete_reasons?: Record<string, string> };
  created_at: number;
}

const fetchRunEvaluations = async (runUuid: string): Promise<RunEvaluation[]> => {
  try {
    const response = (await getJson({
      relativeUrl: `ajax-api/2.0/deeplore/runs/${encodeURIComponent(runUuid)}/evaluations`,
    })) as { evaluations: RunEvaluation[] };
    return response.evaluations;
  } catch (error) {
    if (error instanceof ErrorWrapper) {
      throw new Error(error.getMessageField());
    }
    throw error;
  }
};

// ===== Shared fields =====

const formatEvaluationTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString('en-US', { timeZoneName: 'short' });

const EvaluationField = ({ label, children }: { label: string; children: React.ReactNode }) => {
  const { theme } = useDesignSystemTheme();
  return (
    <div css={{ minWidth: 0 }}>
      <dt css={{ color: theme.colors.textSecondary, marginBottom: theme.spacing.xs }}>{label}</dt>
      <dd css={{ margin: 0, overflowWrap: 'anywhere' }}>
        {children ?? <Typography.Hint>Not recorded</Typography.Hint>}
      </dd>
    </div>
  );
};

const EvaluationArtifactLink = ({
  experimentId,
  runUuid,
  artifactPath,
}: {
  experimentId: string;
  runUuid: string;
  artifactPath: string;
}) => <Link to={Routes.getRunPageRoute(experimentId, runUuid, artifactPath)}>{artifactPath}</Link>;

// ===== Evaluation records =====

const EvaluationRecord = ({
  evaluation,
  experimentId,
  runUuid,
}: {
  evaluation: RunEvaluation;
  experimentId: string;
  runUuid: string;
}) => {
  const { theme } = useDesignSystemTheme();
  const metricEntries = Object.entries(evaluation.metrics).sort(([left], [right]) => left.localeCompare(right));
  const { incomplete_reasons: incompleteReasons = {}, ...additionalMetadata } = evaluation.metadata;
  const fieldStyles = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
    gap: theme.spacing.md,
    margin: 0,
  };

  return (
    <section
      aria-label={`Evaluation ${evaluation.evaluation_id}`}
      css={{
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.borders.borderRadiusMd,
        padding: theme.spacing.md,
      }}
    >
      <div
        css={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: theme.spacing.sm,
          marginBottom: theme.spacing.md,
        }}
      >
        <div css={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.sm }}>
          <Typography.Title level={3} withoutMargins>
            {evaluation.benchmark_name ?? evaluation.dataset_name ?? 'Evaluation'}
          </Typography.Title>
          {evaluation.association_status === 'pending' && (
            <Tag componentId="mlflow.run_evaluations.pending_association" color="default">
              Dataset association pending
            </Tag>
          )}
        </div>
        <Typography.Hint>
          {evaluation.evaluated_at === null
            ? 'Evaluation time not recorded'
            : `Evaluated: ${formatEvaluationTime(evaluation.evaluated_at)}`}
        </Typography.Hint>
      </div>
      <dl css={fieldStyles}>
        <EvaluationField label="Dataset name">{evaluation.dataset_name}</EvaluationField>
        <EvaluationField label="Dataset version">{evaluation.dataset_version}</EvaluationField>
        <EvaluationField label="Test hash">{evaluation.test_hash}</EvaluationField>
        <EvaluationField label="Checkpoint path">
          {evaluation.ckpt_path ? (
            <EvaluationArtifactLink experimentId={experimentId} runUuid={runUuid} artifactPath={evaluation.ckpt_path} />
          ) : null}
        </EvaluationField>
        <EvaluationField
          label={`Checkpoint hash${evaluation.ckpt_hash_algorithm ? ` (${evaluation.ckpt_hash_algorithm})` : ''}`}
        >
          {evaluation.ckpt_hash}
        </EvaluationField>
        <EvaluationField label="Report artifacts">
          {evaluation.artifact_path ? (
            <EvaluationArtifactLink
              experimentId={experimentId}
              runUuid={runUuid}
              artifactPath={evaluation.artifact_path}
            />
          ) : null}
        </EvaluationField>
      </dl>
      {Object.keys(incompleteReasons).length > 0 && (
        <Typography.Paragraph css={{ marginTop: theme.spacing.md, marginBottom: 0 }}>
          <Typography.Hint>Some historical fields are unavailable. Expand details to see why.</Typography.Hint>
        </Typography.Paragraph>
      )}
      <details css={{ marginTop: theme.spacing.md }}>
        <summary css={{ cursor: 'pointer', color: theme.colors.actionPrimaryBackgroundDefault }}>
          Metrics ({metricEntries.length}) and details
        </summary>
        {metricEntries.length ? (
          <div css={{ overflowX: 'auto', marginTop: theme.spacing.md, marginBottom: theme.spacing.md }}>
            <Table aria-label={`Metrics for evaluation ${evaluation.evaluation_id}`}>
              <TableRow isHeader>
                <TableHeader componentId="mlflow.run_evaluations.metric_name">Metric</TableHeader>
                <TableHeader componentId="mlflow.run_evaluations.metric_value">Value</TableHeader>
              </TableRow>
              {metricEntries.map(([name, value]) => (
                <TableRow key={name}>
                  <TableCell multiline css={{ overflowWrap: 'anywhere' }}>
                    {name}
                  </TableCell>
                  <TableCell>{value ?? <Typography.Hint>Not recorded</Typography.Hint>}</TableCell>
                </TableRow>
              ))}
            </Table>
          </div>
        ) : (
          <Typography.Paragraph css={{ marginTop: theme.spacing.md }}>No metrics recorded.</Typography.Paragraph>
        )}
        <dl css={fieldStyles}>
          <EvaluationField label="Evaluation ID">{evaluation.evaluation_id}</EvaluationField>
          <EvaluationField label="Recorded">{formatEvaluationTime(evaluation.created_at)}</EvaluationField>
          {evaluation.source_artifact && (
            <EvaluationField label="Original evaluation table">
              <EvaluationArtifactLink
                experimentId={experimentId}
                runUuid={runUuid}
                artifactPath={evaluation.source_artifact}
              />
            </EvaluationField>
          )}
        </dl>
        {Object.keys(incompleteReasons).length > 0 && (
          <div css={{ marginTop: theme.spacing.md }}>
            <Typography.Title level={4} withoutMargins>
              Historical record details
            </Typography.Title>
            <ul css={{ marginBottom: 0 }}>
              {Object.entries(incompleteReasons).map(([field, reason]) => (
                <li key={field}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {Object.keys(additionalMetadata).length > 0 && (
          <details css={{ marginTop: theme.spacing.md }}>
            <summary css={{ cursor: 'pointer' }}>Additional metadata</summary>
            <pre css={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: theme.spacing.sm }}>
              {JSON.stringify(additionalMetadata, null, 2)}
            </pre>
          </details>
        )}
      </details>
    </section>
  );
};

// ===== Run tab =====

/** Displays every database evaluation associated with the selected run. */
export const RunViewEvaluations = ({ experimentId, runUuid }: { experimentId: string; runUuid: string }) => {
  const { theme } = useDesignSystemTheme();
  const evaluations = useQuery<RunEvaluation[], Error>(
    ['deeplore-run-evaluations', runUuid],
    () => fetchRunEvaluations(runUuid),
    { refetchOnWindowFocus: false, retry: false },
  );
  const records = [...(evaluations.data ?? [])].sort(
    (left, right) =>
      (right.evaluated_at ?? -Infinity) - (left.evaluated_at ?? -Infinity) || right.created_at - left.created_at,
  );

  return (
    <div css={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, paddingTop: theme.spacing.md }}>
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
          marginBottom: theme.spacing.md,
        }}
      >
        <div>
          <Typography.Title level={2} withoutMargins>
            Evaluations{evaluations.data ? ` (${records.length})` : ''}
          </Typography.Title>
          <Typography.Hint>Benchmark results for this run. Most recent evaluations appear first.</Typography.Hint>
        </div>
        <Button
          componentId="mlflow.run_evaluations.refresh"
          onClick={() => evaluations.refetch()}
          disabled={evaluations.isFetching}
        >
          Refresh
        </Button>
      </div>
      {evaluations.isLoading && <Spinner aria-label="Loading evaluations" />}
      {evaluations.isError && (
        <Alert
          componentId="mlflow.run_evaluations.error"
          type="error"
          closable={false}
          message="Unable to load evaluations"
          description={evaluations.error.message}
          css={{ marginBottom: theme.spacing.md }}
        />
      )}
      {!evaluations.isLoading && !evaluations.isError && records.length === 0 && (
        <Empty title="No evaluations recorded" description="This run has no saved benchmark evaluations." />
      )}
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md, paddingBottom: theme.spacing.md }}>
        {records.map((evaluation) => (
          <EvaluationRecord
            key={evaluation.evaluation_id}
            evaluation={evaluation}
            experimentId={experimentId}
            runUuid={runUuid}
          />
        ))}
      </div>
    </div>
  );
};
