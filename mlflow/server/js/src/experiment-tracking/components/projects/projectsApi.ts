/**
 * Project API: response types, experiment membership, then requests to the Deeplore project endpoints.
 * A project is registered on the server; an experiment belongs to the project named by its `project` tag.
 * Naming: get* reads an entity in memory; fetch* reads the server; create* and delete* change registrations.
 */
import { deleteJson, getJson, postJson } from '../../../common/utils/FetchUtils';
import type { ExperimentEntity } from '../../types';

// ===== Response types =====

export interface Project {
  name: string;
  description: string | null;
  created_at: number;
}

// Same rule as the server: one lowercase field, because published files are named <project>-<run_num>.
export const PROJECT_NAME_PATTERN = /^[a-z0-9_]+$/;

// ===== Experiment membership =====

export const PROJECT_TAG = 'project';

/** Return the project that owns an experiment, or undefined for an experiment created outside any project. */
export const getExperimentProject = (experiment: Pick<ExperimentEntity, 'tags'>): string | undefined =>
  experiment.tags?.find((tag) => tag.key === PROJECT_TAG)?.value || undefined;

// ===== Requests =====

const API = 'ajax-api/2.0/deeplore';

const projectPath = (name: string) => `/projects/${encodeURIComponent(name)}`;

export const fetchProjects = () =>
  (getJson({ relativeUrl: `${API}/projects` }) as Promise<{ projects: Project[] }>).then(
    (response) => response.projects,
  );

export const createProject = (name: string, description: string) =>
  (postJson({ relativeUrl: `${API}/projects`, data: { name, description } }) as Promise<{ project: Project }>).then(
    (response) => response.project,
  );

export const deleteProject = (name: string) =>
  deleteJson({ relativeUrl: `${API}${projectPath(name)}`, data: {} }) as Promise<{ deleted: string }>;

export const createProjectExperiment = (project: string, name: string, artifactLocation?: string) =>
  (
    postJson({
      relativeUrl: `${API}${projectPath(project)}/experiments`,
      data: { name, artifact_location: artifactLocation || undefined },
    }) as Promise<{ experiment_id: string }>
  ).then((response) => response.experiment_id);
