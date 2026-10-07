/**
 * Run evaluations: response types and requests, shared fields and lists, evaluation records, then the run tab.
 * Naming: fetch* reads the server; format* prepares display values; components describe their content.
 */
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  ChevronRightIcon,
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
import { RunDatasetEntry } from './overview/RunViewDatasetBox';

// ===== Response types and requests =====

interface RunEvaluation {
  evaluation_id: string;
  run_id: string;
  association_status: 'confirmed' | 'pending';
  dataset_name: string | null;
  dataset_version: string | null;
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

const EVALUATION_LABEL_WIDTH = 120;

const formatEvaluationTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString('en-US', { timeZoneName: 'short' });

const EvaluationField = ({ label, children }: { label: string; children: React.ReactNode }) => {
  const { theme } = useDesignSystemTheme();
  return (
    <div css={{ display: 'flex', alignItems: 'baseline', gap: theme.spacing.sm, minWidth: 0, maxWidth: '100%' }}>
      <dt css={{ color: theme.colors.textSecondary, flexShrink: 0 }}>{label}</dt>
      <dd css={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
        {children ?? <Typography.Hint>Not recorded</Typography.Hint>}
      </dd>
    </div>
  );
};

const EvaluationRow = ({
  label,
  children,
}: {
  label: 'evaluation' | 'dataset' | 'checkpoint';
  children: React.ReactNode;
}) => {
  const { theme } = useDesignSystemTheme();
  const Content = label === 'dataset' ? 'div' : 'dl';
  return (
    <div
      css={{
        display: 'grid',
        gridTemplateColumns: `${EVALUATION_LABEL_WIDTH}px minmax(0, 1fr)`,
        gap: theme.spacing.lg,
        alignItems: 'start',
      }}
    >
      <Typography.Text bold css={{ paddingLeft: theme.spacing.md + theme.spacing.sm }}>
        {label}
      </Typography.Text>
      <Content
        css={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          alignItems: 'start',
          gap: theme.spacing.lg,
          margin: 0,
        }}
      >
        {children}
      </Content>
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
  label: 'metrics' | 'params';
  values: Record<string, string | number | boolean | null>;
}) => {
  const { theme } = useDesignSystemTheme();
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return (
    <details css={{ '&[open] .evaluation-disclosure-icon': { transform: 'rotate(90deg)' } }}>
      <summary
        css={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing.sm,
          cursor: 'pointer',
          listStyle: 'none',
          '&::-webkit-details-marker': { display: 'none' },
        }}
      >
        <ChevronRightIcon className="evaluation-disclosure-icon" css={{ color: theme.colors.textSecondary }} />
        <Typography.Text bold>{label}</Typography.Text>
        <Typography.Hint>({entries.length})</Typography.Hint>
      </summary>
      {entries.length ? (
        <div
          css={{
            overflowX: 'auto',
            marginTop: theme.spacing.md,
            marginLeft: EVALUATION_LABEL_WIDTH + theme.spacing.lg,
          }}
        >
          <Table
            noMinHeight
            css={{
              '[role="row"] > :first-child': { flex: '0 1 240px', minWidth: 0 },
              '[role="row"] > :last-child': { flex: '1 1 0', minWidth: 0 },
            }}
          >
            <TableRow isHeader>
              <TableHeader componentId="mlflow.run_evaluations.entry_name">
                {label === 'metrics' ? 'Metric' : 'Parameter'}
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
        <Typography.Paragraph
          css={{ marginTop: theme.spacing.md, marginBottom: 0, marginLeft: EVALUATION_LABEL_WIDTH + theme.spacing.lg }}
        >
          {label === 'metrics' ? 'No metrics recorded.' : 'No parameters recorded.'}
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
  return (
    <section
      aria-label={`Evaluation ${evaluation.evaluation_id}`}
      css={{
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.borders.borderRadiusMd,
        padding: theme.spacing.md,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.lg,
      }}
    >
      <EvaluationRow label="evaluation">
        <EvaluationField label="id">{evaluation.evaluation_id}</EvaluationField>
        <EvaluationField label="time">
          {evaluation.evaluated_at === null ? null : formatEvaluationTime(evaluation.evaluated_at)}
        </EvaluationField>
      </EvaluationRow>
      <EvaluationRow label="dataset">
        <div
          css={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: theme.spacing.xs,
            gridColumn: '1 / -1',
            minWidth: 0,
            overflowWrap: 'anywhere',
          }}
        >
          {evaluation.dataset_name ? (
            <RunDatasetEntry
              dataset={{
                name: evaluation.dataset_name,
                version: evaluation.dataset_version ?? undefined,
                link:
                  evaluation.association_status === 'confirmed' && evaluation.dataset_version
                    ? `${Routes.datasetsPageRoute}?${new URLSearchParams({
                        name: evaluation.dataset_name,
                        version: evaluation.dataset_version,
                      })}`
                    : undefined,
              }}
            />
          ) : (
            <Typography.Hint>Not recorded</Typography.Hint>
          )}
          {evaluation.association_status === 'pending' && (
            <Tag
              componentId="mlflow.run_evaluations.pending_association"
              color="default"
              css={{ maxWidth: '100%', whiteSpace: 'normal', height: 'auto' }}
            >
              Dataset association pending
            </Tag>
          )}
        </div>
      </EvaluationRow>
      <EvaluationRow label="checkpoint">
        <EvaluationField label="path">
          {evaluation.ckpt_path ? (
            <EvaluationArtifactLink experimentId={experimentId} runUuid={runUuid} artifactPath={evaluation.ckpt_path} />
          ) : null}
        </EvaluationField>
        <EvaluationField label="hash">{evaluation.ckpt_hash}</EvaluationField>
      </EvaluationRow>
      <EvaluationValues label="params" values={evaluation.params} />
      <EvaluationValues label="metrics" values={evaluation.metrics} />
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
  const datasetGroups = new Map<string | null, RunEvaluation[]>();
  for (const evaluation of records) {
    const group = datasetGroups.get(evaluation.dataset_name) ?? [];
    group.push(evaluation);
    datasetGroups.set(evaluation.dataset_name, group);
  }

  return (
    <div css={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, paddingTop: theme.spacing.md }}>
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
        {[...datasetGroups].map(([datasetName, datasetRecords]) => (
          <section
            key={datasetName ?? 'pending-dataset'}
            aria-label={`Dataset ${datasetName ?? 'Pending dataset'}`}
            css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}
          >
            <Typography.Title level={3} withoutMargins>
              {datasetName ?? 'Pending dataset'} ({datasetRecords.length})
            </Typography.Title>
            {datasetRecords.map((evaluation) => (
              <EvaluationRecord
                key={evaluation.evaluation_id}
                evaluation={evaluation}
                experimentId={experimentId}
                runUuid={runUuid}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
};
