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
  runNumber?: string;
  modelName?: string;
  change?: string;
  metricComparisons: { baseRunId: string; baseRunNumber?: string; difference?: number }[];
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

/** Match deeplore_core's project field in valid <project>-<suffix> experiment names. */
export const buildExperimentProject = (name: string): string | undefined => {
  const separator = name.indexOf('-');
  const project = name.slice(0, separator);
  return separator > 0 && !/\s/.test(project) && name.slice(separator + 1).trim() ? project : undefined;
};

/** Read a run number from r12, a padded r012, or the leading field of a run name written before base_run held numbers. */
export const buildRunNumber = (reference?: string): string | undefined => {
  const match = /^r0*([1-9]\d*)(?:-|$)/.exec(reference ?? '');
  return match ? `r${match[1]}` : undefined;
};

const buildRunName = (run: RunEntity): string =>
  run.data.tags?.find((tag) => tag.key === 'mlflow.runName')?.value || run.info.runName || run.info.runUuid;

const buildLineageNode = (
  run: RunEntity,
  experimentNames: Map<string, string>,
  metricValues: ReadonlyMap<string, number>,
  isExternal: boolean,
): LineageNode => {
  const tags = new Map((run.data.tags ?? []).map((tag) => [tag.key, tag.value]));
  const metric = metricValues.get(run.info.runUuid);
  const datasetVersions = (run.inputs?.datasetInputs ?? []).flatMap((input) => {
    const inputTags = new Map(input.tags.map((tag) => [tag.key, tag.value]));
    if (!['training', 'train', 'validation', 'val', 'trainval'].includes(inputTags.get('mlflow.data.context') ?? '')) {
      return [];
    }
    const version = inputTags.get('version') || inputTags.get('trainval_version') || inputTags.get('data_version');
    return version ? [version] : [];
  });
  return {
    runId: run.info.runUuid,
    runName: buildRunName(run),
    runNumber: tags.get('run_num') || undefined,
    modelName: tags.get('model') || undefined,
    change: tags.get('change') || undefined,
    experimentId: run.info.experimentId,
    experimentName: experimentNames.get(run.info.experimentId) ?? run.info.experimentId,
    metric: Number.isFinite(metric) ? metric : undefined,
    metricComparisons: [],
    datasetVersion: [...new Set(datasetVersions)].join(', ') || undefined,
    status: run.info.status,
    isExternal,
    isRoot: !isExternal,
  };
};

/** Resolve base_run numbers only when exactly one active run in the same project carries them. */
export const buildLineageGraph = (
  runs: RunEntity[],
  experiments: Pick<ExperimentEntity, 'experimentId' | 'name'>[],
  metricValues: ReadonlyMap<string, number>,
  baseRuns: RunEntity[] = [],
): LineageGraph => {
  const experimentNames = new Map(experiments.map((experiment) => [experiment.experimentId, experiment.name]));
  const uniqueRuns = new Map(
    runs.filter((run) => run.info.lifecycleStage !== 'deleted').map((run) => [run.info.runUuid, run]),
  );
  const candidateRuns = new Map(
    [...baseRuns, ...runs].filter((run) => run.info.lifecycleStage !== 'deleted').map((run) => [run.info.runUuid, run]),
  );
  const buildProjectKey = (run: RunEntity): string => {
    const project = buildExperimentProject(experimentNames.get(run.info.experimentId) ?? '');
    return project ? `project:${project}` : `experiment:${run.info.experimentId}`;
  };
  const parentsByNumber = new Map<string, RunEntity[]>();
  for (const run of candidateRuns.values()) {
    const runNumber = buildRunNumber(run.data.tags?.find((tag) => tag.key === 'run_num')?.value);
    if (!runNumber) continue;
    const key = JSON.stringify([buildProjectKey(run), runNumber]);
    parentsByNumber.set(key, [...(parentsByNumber.get(key) ?? []), run]);
  }
  const orderedRuns = [...uniqueRuns.values()].sort(
    (left, right) =>
      (left.info.startTime || 0) - (right.info.startTime || 0) || left.info.runUuid.localeCompare(right.info.runUuid),
  );
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];

  for (const run of orderedRuns) {
    nodes.set(run.info.runUuid, buildLineageNode(run, experimentNames, metricValues, false));
  }

  for (const run of orderedRuns) {
    const tags = new Map((run.data.tags ?? []).map((tag) => [tag.key, tag.value]));
    const parentNames = splitTag(tags.get('base_run'));
    const seenParents = new Set<string>();
    parentNames.forEach((parentName) => {
      if (parentName.toLowerCase() === 'none' || seenParents.has(parentName)) return;
      seenParents.add(parentName);
      // A reference without a run number stays visible as a missing parent.
      const parentKey = JSON.stringify([buildProjectKey(run), buildRunNumber(parentName) ?? parentName]);
      const matches = parentsByNumber.get(parentKey) ?? [];
      const parentRun = matches.length === 1 ? matches[0] : undefined;
      const parentId = parentRun?.info.runUuid ?? `missing:${parentKey}`;
      if (!nodes.has(parentId)) {
        const parent: LineageNode = parentRun
          ? buildLineageNode(parentRun, experimentNames, metricValues, true)
          : {
              runId: parentId,
              runName: parentName,
              metricComparisons: [],
              status: matches.length > 1 ? 'AMBIGUOUS' : 'MISSING',
              isExternal: true,
              isRoot: false,
            };
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
          baseRunNumber: parent?.runNumber,
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
    throw new Error('Run lineage contains a cycle. Correct the base_run tags before viewing the graph.');
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

/** Keep unresolved historical references visible without presenting a clickable run. */
export const formatRunHeading = (node: LineageNode): string =>
  node.experimentId
    ? node.runNumber || '--'
    : `${node.runName} (${node.status === 'AMBIGUOUS' ? 'ambiguous' : 'missing'})`;

export const formatDifference = (value?: number): string => {
  if (value === undefined) return '--';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  const label = magnitude < 0.001 ? magnitude.toExponential(2) : String(Number(magnitude.toFixed(3)));
  return `${value > 0 ? '+' : '-'}${label}`;
};

/** Keep metric comparison labels identical in sizing and rendering. */
export const formatComparison = (comparison: LineageNode['metricComparisons'][number], showBase: boolean): string =>
  `${showBase ? `${comparison.baseRunNumber ?? comparison.baseRunId.slice(0, 8)} ` : ''}${formatDifference(
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
            Math.max(LINEAGE_CARD.valueOffset + fieldWidth, measureText(formatRunHeading(node), 700)),
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
