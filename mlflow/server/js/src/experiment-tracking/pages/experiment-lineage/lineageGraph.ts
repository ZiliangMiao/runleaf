/**
 * Run lineage: data types, topology construction, card formatting, then graph layout.
 * Naming: build_* constructs data; validate_* checks invariants; format_* produces labels.
 */
import { graphlib, layout } from '@dagrejs/dagre';
import type { ExperimentEntity, RunEntity } from '../../types';

// ===== Data types =====

export type LineageNode = {
  runId: string;
  runName: string;
  runSequence?: string;
  modelName?: string;
  change?: string;
  metricComparisons: { baseRunId: string; baseRunSequence?: string; difference?: number }[];
  experimentId?: string;
  experimentName?: string;
  metric?: number;
  datasetVersion?: string;
  status?: string;
  isExternal: boolean;
  isRoot: boolean;
};

export type LineageEdge = { source: string; target: string; change: string };
export type LineageGraph = { nodes: LineageNode[]; edges: LineageEdge[] };
export type LineagePoint = { x: number; y: number };
export type LineageRectangle = LineagePoint & { width: number; height: number };
export type LineageLayout = {
  width: number;
  height: number;
  nodes: (LineageNode & LineageRectangle)[];
  edges: (LineageEdge & LineagePoint & { points: LineagePoint[] })[];
  groups: (LineageRectangle & { experimentId: string; name: string })[];
};

// ===== Topology construction =====

const splitTag = (value?: string): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const buildLineageNode = (
  run: RunEntity,
  experimentNames: Map<string, string>,
  metricKey: string,
  isExternal: boolean,
): LineageNode => {
  const tags = new Map((run.data.tags ?? []).map((tag) => [tag.key, tag.value]));
  const metric = run.data.metrics?.find((candidate) => candidate.key === metricKey)?.value;
  return {
    runId: run.info.runUuid,
    runName: tags.get('mlflow.runName') || run.info.runName || run.info.runUuid,
    runSequence: tags.get('run_seq') || undefined,
    modelName: tags.get('model_name') || undefined,
    change: tags.get('change') || undefined,
    experimentId: run.info.experimentId,
    experimentName: experimentNames.get(run.info.experimentId) ?? run.info.experimentId,
    metric: Number.isFinite(metric) ? metric : undefined,
    metricComparisons: [],
    datasetVersion: tags.get('trainval_version') || undefined,
    status: run.info.status,
    isExternal,
    isRoot: !isExternal,
  };
};

/** Build rename-safe parent edges using the same tags as deeplore_core.mlflow_run. */
export const buildLineageGraph = (
  runs: RunEntity[],
  experiments: Pick<ExperimentEntity, 'experimentId' | 'name'>[],
  metricKey: string,
  baseRuns: RunEntity[] = [],
): LineageGraph => {
  const experimentNames = new Map(experiments.map((experiment) => [experiment.experimentId, experiment.name]));
  const uniqueRuns = new Map(runs.map((run) => [run.info.runUuid, run]));
  const externalRuns = new Map(baseRuns.map((run) => [run.info.runUuid, run]));
  const orderedRuns = [...uniqueRuns.values()].sort(
    (left, right) =>
      (left.info.startTime || 0) - (right.info.startTime || 0) || left.info.runUuid.localeCompare(right.info.runUuid),
  );
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];

  for (const run of orderedRuns) {
    nodes.set(run.info.runUuid, buildLineageNode(run, experimentNames, metricKey, false));
  }

  for (const run of orderedRuns) {
    const tags = new Map((run.data.tags ?? []).map((tag) => [tag.key, tag.value]));
    const parentNames = splitTag(tags.get('base_run'));
    const parentSequences = (tags.get('base_run_seq') ?? '').split(',').map((sequence) => sequence.trim() || undefined);
    const seenParents = new Set<string>();
    splitTag(tags.get('base_run_id')).forEach((parentId, index) => {
      // Names label external parents; only immutable IDs establish relationships.
      if (parentId.toLowerCase() === 'none' || seenParents.has(parentId)) return;
      seenParents.add(parentId);
      if (!nodes.has(parentId)) {
        const parentRun = externalRuns.get(parentId);
        const parent: LineageNode = parentRun
          ? buildLineageNode(parentRun, experimentNames, metricKey, true)
          : {
              runId: parentId,
              runName: parentNames[index] || parentId,
              runSequence: parentSequences[index],
              metricComparisons: [],
              isExternal: true,
              isRoot: false,
            };
        parent.runSequence ??= parentSequences[index];
        nodes.set(parentId, parent);
      }
      const child = nodes.get(run.info.runUuid);
      const parent = nodes.get(parentId);
      if (child) {
        child.isRoot = false;
        const difference =
          child.metric !== undefined && parent?.metric !== undefined ? child.metric - parent.metric : undefined;
        child.metricComparisons.push({
          baseRunId: parentId,
          baseRunSequence: parent?.runSequence || parentSequences[index],
          difference: Number.isFinite(difference) ? difference : undefined,
        });
      }
      edges.push({ source: parentId, target: run.info.runUuid, change: tags.get('change') || '' });
    });
  }
  return { nodes: [...nodes.values()], edges };
};

/** Reject cyclic metadata instead of silently reversing parent edges for layout. */
export const validateLineageGraph = (graph: LineageGraph): void => {
  const counts = new Map(graph.nodes.map((node) => [node.runId, 0]));
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    const descendants = children.get(edge.source) ?? [];
    descendants.push(edge.target);
    children.set(edge.source, descendants);
  }
  const queue = [...counts].filter(([, count]) => count === 0).map(([runId]) => runId);
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      const count = (counts.get(child) ?? 0) - 1;
      counts.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  if (queue.length !== graph.nodes.length) {
    throw new Error('Run lineage contains a cycle. Correct the base_run_id tags before viewing the graph.');
  }
};

// ===== Card formatting =====

export const LINEAGE_CARD = {
  fontFamily: 'Arial, sans-serif',
  fontSize: 15,
  padding: 14,
  valueOffset: 68,
  firstRow: 40,
  rowSpacing: 22,
  height: 122,
  differenceSpacing: 12,
};

export const formatMetric = (value?: number): string =>
  value === undefined ? '--' : Number.isFinite(value) ? value.toFixed(3) : String(value);

export const formatDifference = (value?: number): string => {
  if (value === undefined) return '--';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  const label = magnitude < 0.001 ? magnitude.toExponential(2) : String(Number(magnitude.toFixed(3)));
  return `${value > 0 ? '+' : '-'}${label}`;
};

/** Keep metric comparison labels identical in sizing and rendering. */
export const formatComparison = (comparison: LineageNode['metricComparisons'][number], showBase: boolean): string =>
  `${showBase ? `${comparison.baseRunSequence ?? comparison.baseRunId.slice(0, 8)} ` : ''}${formatDifference(
    comparison.difference,
  )}`;

// ===== Graph layout =====

/** Position nodes and experiment groups without changing their relationships. */
export const buildLineageLayout = (lineage: LineageGraph): LineageLayout => {
  validateLineageGraph(lineage);
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  const measureText = (value: string, weight = 400): number => {
    if (!context) return Array.from(value).length * LINEAGE_CARD.fontSize;
    context.font = `${weight} ${LINEAGE_CARD.fontSize}px ${LINEAGE_CARD.fontFamily}`;
    return context.measureText(value).width;
  };
  const graph = new graphlib.Graph({ compound: true });
  graph.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 76, marginx: 24, marginy: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  const groups = new Map<string, string>();
  for (const node of lineage.nodes) {
    if (!node.isExternal && node.experimentId) {
      groups.set(node.experimentId, node.experimentName ?? node.experimentId);
    }
  }
  if (groups.size > 1) {
    for (const [experimentId, name] of groups) {
      graph.setNode(`experiment:${experimentId}`, { label: name });
    }
  }
  for (const node of lineage.nodes) {
    const metricWidth =
      measureText(formatMetric(node.metric)) +
      node.metricComparisons.reduce(
        (width, comparison) =>
          width +
          LINEAGE_CARD.differenceSpacing +
          measureText(formatComparison(comparison, node.metricComparisons.length > 1)),
        0,
      );
    const fieldWidth = Math.max(
      ...[node.modelName, node.change, node.datasetVersion].map((value) => measureText(value || '--')),
      metricWidth,
    );
    // Size from rendered labels so long values stay complete on a single line.
    graph.setNode(`run:${node.runId}`, {
      width: Math.ceil(
        Math.max(
          240,
          LINEAGE_CARD.padding * 2 +
            2 +
            Math.max(LINEAGE_CARD.valueOffset + fieldWidth, measureText(node.runSequence || '--', 700)),
        ),
      ),
      height: LINEAGE_CARD.height,
    });
    if (groups.size > 1 && !node.isExternal && node.experimentId) {
      graph.setParent(`run:${node.runId}`, `experiment:${node.experimentId}`);
    }
  }
  for (const edge of lineage.edges) {
    graph.setEdge(`run:${edge.source}`, `run:${edge.target}`, {
      width: edge.change ? Math.min(250, edge.change.length * 7 + 12) : 0,
      height: edge.change ? 38 : 0,
      labelpos: 'c',
    });
  }
  layout(graph);
  return {
    width: graph.graph().width ?? 1,
    height: graph.graph().height ?? 1,
    nodes: lineage.nodes.map((node) => ({ ...node, ...graph.node(`run:${node.runId}`) })),
    edges: lineage.edges.map((edge) => ({
      ...edge,
      ...graph.edge(`run:${edge.source}`, `run:${edge.target}`),
      x: graph.edge(`run:${edge.source}`, `run:${edge.target}`)['x'] ?? 0,
      y: graph.edge(`run:${edge.source}`, `run:${edge.target}`)['y'] ?? 0,
    })),
    groups:
      groups.size > 1
        ? [...groups].map(([experimentId, name]) => ({
            experimentId,
            name,
            ...graph.node(`experiment:${experimentId}`),
          }))
        : [],
  };
};
