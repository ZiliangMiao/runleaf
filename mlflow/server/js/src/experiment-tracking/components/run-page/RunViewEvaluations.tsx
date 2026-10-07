/**
 * Run evaluations: response types and requests, shared fields and lists, evaluation records, then the run tab.
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
  test_hash: string | null;
  ckpt_path: string | null;
  ckpt_hash: string | null;
  evaluated_at: number | null;
  metrics: Record<string, number | null>;
  params: Record<string, string | number | boolean | null>;
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

// ===== Shared fields and lists =====

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

const EvaluationValues = ({
  label,
  values,
}: {
  label: 'Metrics' | 'Params';
  values: Record<string, string | number | boolean | null>;
}) => {
  const { theme } = useDesignSystemTheme();
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return (
    <details css={{ marginTop: theme.spacing.md }}>
      <summary css={{ cursor: 'pointer', color: theme.colors.actionPrimaryBackgroundDefault }}>
        {label} ({entries.length})
      </summary>
      {entries.length ? (
        <div css={{ overflowX: 'auto', marginTop: theme.spacing.md }}>
          <Table>
            <TableRow isHeader>
              <TableHeader componentId="mlflow.run_evaluations.entry_name">
                {label === 'Metrics' ? 'Metric' : 'Parameter'}
              </TableHeader>
              <TableHeader componentId="mlflow.run_evaluations.entry_value">Value</TableHeader>
            </TableRow>
            {entries.map(([name, value]) => (
              <TableRow key={name}>
                <TableCell multiline css={{ overflowWrap: 'anywhere' }}>
                  {name}
                </TableCell>
                <TableCell multiline css={{ overflowWrap: 'anywhere' }}>
                  {value === null ? <Typography.Hint>Not recorded</Typography.Hint> : String(value)}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      ) : (
        <Typography.Paragraph css={{ marginTop: theme.spacing.md }}>
          {label === 'Metrics' ? 'No metrics recorded.' : 'No parameters recorded.'}
        </Typography.Paragraph>
      )}
    </details>
  );
};

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
            {evaluation.dataset_name ?? 'Pending dataset'}
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
        <EvaluationField label="Evaluation ID">{evaluation.evaluation_id}</EvaluationField>
        <EvaluationField label="Dataset name">{evaluation.dataset_name}</EvaluationField>
        <EvaluationField label="Dataset version">{evaluation.dataset_version}</EvaluationField>
        <EvaluationField label="Test hash">{evaluation.test_hash}</EvaluationField>
        <EvaluationField label="Checkpoint path">
          {evaluation.ckpt_path ? (
            <EvaluationArtifactLink experimentId={experimentId} runUuid={runUuid} artifactPath={evaluation.ckpt_path} />
          ) : null}
        </EvaluationField>
        <EvaluationField label="Checkpoint hash">{evaluation.ckpt_hash}</EvaluationField>
        <EvaluationField label="Recorded time">{formatEvaluationTime(evaluation.created_at)}</EvaluationField>
      </dl>
      <EvaluationValues label="Metrics" values={evaluation.metrics} />
      <EvaluationValues label="Params" values={evaluation.params} />
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
