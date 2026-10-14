/**
 * Project modals: register a project, then delete an empty one.
 * Naming: handle* responds to interactions.
 */
import { useState } from 'react';
import { Alert, Input, Modal, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { ErrorWrapper } from '../../../common/utils/ErrorWrapper';
import { PROJECT_NAME_PATTERN, createProject, deleteProject } from './projectsApi';

const getErrorMessage = (error: unknown) =>
  error instanceof ErrorWrapper ? error.getMessageField() : error instanceof Error ? error.message : String(error);

// ===== Project creation =====

/** Register a project; experiments are then created inside it. */
export const CreateProjectModal = ({
  existingNames,
  onClose,
  onCreated,
}: {
  existingNames: string[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const nameError = !name
    ? undefined
    : !PROJECT_NAME_PATTERN.test(name)
    ? 'Use lowercase letters, digits and underscores only.'
    : existingNames.includes(name)
    ? `Project "${name}" already exists.`
    : undefined;
  const handleCreate = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await createProject(name, description.trim());
      onCreated(name);
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setSubmitting(false);
    }
  };
  const fieldStyles = { display: 'block', marginBottom: 4, marginTop: theme.spacing.md };
  return (
    <Modal
      componentId="mlflow.projects.create"
      visible
      title="Create project"
      okText="Create"
      cancelText="Cancel"
      okButtonProps={{ disabled: submitting || !name || Boolean(nameError) }}
      onCancel={onClose}
      onOk={handleCreate}
    >
      <Typography.Hint>
        A project owns experiments and one run number sequence shared by all of them. Its name prefixes published files
        such as &lt;project&gt;-r12.onnx and cannot be changed.
      </Typography.Hint>
      <label htmlFor="project-create-name" css={fieldStyles}>
        Name
      </label>
      <Input
        id="project-create-name"
        componentId="mlflow.projects.create.name"
        aria-label="Name"
        placeholder="Lowercase letters, digits and underscores"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoFocus
      />
      {nameError && <Typography.Text color="error">{nameError}</Typography.Text>}
      <label htmlFor="project-create-description" css={fieldStyles}>
        Description
      </label>
      <Input
        id="project-create-description"
        componentId="mlflow.projects.create.description"
        aria-label="Description"
        placeholder="Optional"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      {error && (
        <Alert
          componentId="mlflow.projects.create.error"
          type="error"
          closable={false}
          message="Unable to create the project"
          description={error}
          css={{ marginTop: theme.spacing.md }}
        />
      )}
    </Modal>
  );
};

// ===== Project deletion =====

/** Delete a project that owns no experiment; the server also counts deleted experiments. */
export const DeleteProjectModal = ({
  name,
  onClose,
  onDeleted,
}: {
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const handleDelete = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await deleteProject(name);
      onDeleted();
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal
      componentId="mlflow.projects.delete"
      visible
      title={`Delete project ${name}?`}
      okText="Delete"
      cancelText="Cancel"
      okButtonProps={{ danger: true, disabled: submitting }}
      onCancel={onClose}
      onOk={handleDelete}
    >
      <p>
        The project owns no active experiment. Its run numbers stay reserved, so a project created again with this name
        continues the sequence.
      </p>
      {error && (
        <Alert
          componentId="mlflow.projects.delete.error"
          type="error"
          closable={false}
          message="Unable to delete the project"
          description={error}
          css={{ marginTop: theme.spacing.md }}
        />
      )}
    </Modal>
  );
};
