import { buildExperimentProject, buildLineageGraph } from './lineageGraph';
import type { RunEntity } from '../../types';

const buildRun = (runUuid: string, experimentId: string, tags: Record<string, string>): RunEntity =>
  ({
    info: { runUuid, experimentId, runName: runUuid, startTime: 1, lifecycleStage: 'active', status: 'FINISHED' },
    data: { tags: Object.entries(tags).map(([key, value]) => ({ key, value })), metrics: [], params: [] },
  } as any);

const inProject = (project: string) => [{ key: 'project', value: project }] as any;

const experiments = [
  { experimentId: '1', name: 'k40', tags: inProject('deepdet') },
  { experimentId: '2', name: 'v3', tags: inProject('deepdet') },
  { experimentId: '3', name: 'deepdet-old', tags: [] },
];

describe('lineage project scope', () => {
  test('the project comes from the experiment tag, never from the name', () => {
    expect(buildExperimentProject(experiments[0])).toBe('deepdet');
    expect(buildExperimentProject(experiments[2])).toBeUndefined();
  });

  test('a base run resolves in another experiment of the same project only', () => {
    const child = buildRun('child', '1', { run_num: 'r9', base_run: 'r5,r6' });
    const sameProject = buildRun('parent', '2', { run_num: 'r5' });
    const untagged = buildRun('stranger', '3', { run_num: 'r6' });
    const graph = buildLineageGraph([child], experiments, new Map(), [sameProject, untagged]);
    const parents = graph.edges.filter((edge) => edge.target === 'child').map((edge) => edge.source);
    expect(parents).toContain('parent');
    expect(parents).not.toContain('stranger');
    expect(graph.nodes.find((node) => node.runId === 'parent')?.experimentName).toBe('v3');
  });
});
