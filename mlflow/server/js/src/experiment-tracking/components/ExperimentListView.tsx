import React, { Component } from 'react';
import {
  Checkbox,
  CaretDownSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusCircleIcon,
  Input,
  PencilIcon,
  Typography,
  WithDesignSystemThemeHoc,
  DesignSystemHocProps,
  Button,
  TrashIcon,
  Tooltip,
} from '@databricks/design-system';
import { List as VList, AutoSizer, ListRowRenderer } from 'react-virtualized';
import 'react-virtualized/styles.css';
import { Link } from '../../common/utils/RoutingUtils';
import Routes from '../routes';
import { CreateExperimentModal } from './modals/CreateExperimentModal';
import { DeleteExperimentModal } from './modals/DeleteExperimentModal';
import { RenameExperimentModal } from './modals/RenameExperimentModal';
import { CreateProjectModal, DeleteProjectModal } from './projects/ProjectModals';
import { getExperimentProject, type Project } from './projects/projectsApi';
import { withRouterNext, WithRouterNextProps } from '../../common/utils/withRouterNext';
import { ExperimentEntity } from '../types';

// Experiments created outside any project are grouped under this key.
const UNASSIGNED = '';

type ListRow =
  | {
      kind: 'project';
      name: string;
      description?: string | null;
      count: number;
      registered: boolean;
      collapsed: boolean;
    }
  | { kind: 'experiment'; experiment: ExperimentEntity };

type Props = {
  activeExperimentIds: string[];
  experiments: ExperimentEntity[];
  projects?: Project[];
  onProjectsChange?: () => void;
} & WithRouterNextProps &
  DesignSystemHocProps;

type State = {
  checkedKeys: string[];
  collapsedProjects: string[];
  hidden: boolean;
  searchInput: string;
  createExperimentProject?: string;
  showCreateProjectModal: boolean;
  deleteProjectName?: string;
  showDeleteExperimentModal: boolean;
  showRenameExperimentModal: boolean;
  selectedExperimentId: string;
  selectedExperimentName: string;
};

/** Sidebar listing projects, each expanding to the experiments it owns. */
export class ExperimentListView extends Component<Props, State> {
  list?: VList = undefined;

  state: State = {
    checkedKeys: this.props.activeExperimentIds,
    collapsedProjects: [],
    hidden: false,
    searchInput: '',
    createExperimentProject: undefined,
    showCreateProjectModal: false,
    deleteProjectName: undefined,
    showDeleteExperimentModal: false,
    showRenameExperimentModal: false,
    selectedExperimentId: '0',
    selectedExperimentName: '',
  };

  bindListRef = (ref: VList) => {
    this.list = ref;
  };

  componentDidUpdate = () => {
    // Ensure the filter is applied
    if (this.list) {
      this.list.forceUpdateGrid();
    }
  };

  // ---- rows ----

  /** Group experiments by project; a search keeps matching experiments and every experiment of a matching project. */
  buildRows = (): ListRow[] => {
    const { experiments, projects = [] } = this.props;
    const { collapsedProjects, searchInput } = this.state;
    const search = searchInput.toLowerCase();
    const registered = new Map(projects.map((project) => [project.name, project]));
    const groups = new Map<string, ExperimentEntity[]>(projects.map((project) => [project.name, []]));
    for (const experiment of experiments) {
      const key = getExperimentProject(experiment) ?? UNASSIGNED;
      groups.set(key, [...(groups.get(key) ?? []), experiment]);
    }
    const names = [...groups.keys()].filter((name) => name !== UNASSIGNED).sort();
    if (groups.get(UNASSIGNED)?.length) {
      names.push(UNASSIGNED);
    }

    const rows: ListRow[] = [];
    for (const name of names) {
      const members = groups.get(name) ?? [];
      const projectMatches = name !== UNASSIGNED && name.toLowerCase().includes(search);
      const shown =
        !search || projectMatches
          ? members
          : members.filter((experiment) => experiment.name.toLowerCase().includes(search));
      if (search && !projectMatches && shown.length === 0) {
        continue;
      }
      const collapsed = !search && collapsedProjects.includes(name);
      rows.push({
        kind: 'project',
        name,
        description: registered.get(name)?.description,
        count: members.length,
        registered: registered.has(name),
        collapsed,
      });
      if (!collapsed) {
        rows.push(...shown.map((experiment): ListRow => ({ kind: 'experiment', experiment })));
      }
    }
    return rows;
  };

  // ---- interactions ----

  handleSearchInputChange: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    this.setState({
      searchInput: event.target.value,
    });
  };

  handleToggleProject = (name: string) => () => {
    this.setState(({ collapsedProjects }) => ({
      collapsedProjects: collapsedProjects.includes(name)
        ? collapsedProjects.filter((project) => project !== name)
        : [...collapsedProjects, name],
    }));
  };

  updateSelectedExperiment = (experimentId: string, experimentName: string) => {
    this.setState({
      selectedExperimentId: experimentId,
      selectedExperimentName: experimentName,
    });
  };

  handleCreateExperiment = (project: string) => () => {
    this.setState({ createExperimentProject: project });
  };

  handleDeleteExperiment = (experimentId: string, experimentName: string) => () => {
    this.setState({
      showDeleteExperimentModal: true,
    });
    this.updateSelectedExperiment(experimentId, experimentName);
  };

  handleRenameExperiment = (experimentId: string, experimentName: string) => () => {
    this.setState({
      showRenameExperimentModal: true,
    });
    this.updateSelectedExperiment(experimentId, experimentName);
  };

  handleCloseCreateExperimentModal = () => {
    this.setState({ createExperimentProject: undefined });
  };

  handleCloseDeleteExperimentModal = () => {
    this.setState({
      showDeleteExperimentModal: false,
    });
    // reset
    this.updateSelectedExperiment('0', '');
  };

  handleCloseRenameExperimentModal = () => {
    this.setState({
      showRenameExperimentModal: false,
    });
    // reset
    this.updateSelectedExperiment('0', '');
  };

  handleProjectsChanged = () => {
    this.setState({ showCreateProjectModal: false, deleteProjectName: undefined });
    this.props.onProjectsChange?.();
  };

  // Add a key if it does not exist, remove it if it does
  // Always keep at least one experiment checked if it is only the active one.
  handleCheck = (isChecked: boolean, key: string) => {
    this.setState((prevState, props) => {
      let { checkedKeys } = prevState;
      if (isChecked === true && !props.activeExperimentIds.includes(key)) {
        checkedKeys = [key, ...props.activeExperimentIds];
      }
      if (isChecked === false && props.activeExperimentIds.length !== 1) {
        checkedKeys = props.activeExperimentIds.filter((i) => i !== key);
      }
      return { checkedKeys: checkedKeys };
    }, this.pushExperimentRoute);
  };

  pushExperimentRoute = () => {
    if (this.state.checkedKeys.length > 0) {
      const route =
        this.state.checkedKeys.length === 1
          ? Routes.getExperimentPageRoute(this.state.checkedKeys[0])
          : Routes.getCompareExperimentsPageRoute(this.state.checkedKeys);
      this.props.navigate(route);
    }
  };

  // ---- rendering ----

  renderProjectRow = (row: Extract<ListRow, { kind: 'project' }>, key: string, style: React.CSSProperties) => {
    const { theme } = this.props.designSystemThemeApi;
    const label = row.name === UNASSIGNED ? 'No project' : row.name;
    return (
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing.xs,
          paddingLeft: theme.spacing.xs,
          paddingRight: theme.spacing.xs,
          borderLeft: 'solid transparent',
          borderLeftWidth: 4,
          fontSize: theme.typography.fontSizeBase,
          svg: {
            width: 14,
            height: 14,
          },
        }}
        data-testid="project-list-item"
        key={key}
        style={style}
      >
        <button
          type="button"
          onClick={this.handleToggleProject(row.name)}
          aria-expanded={!row.collapsed}
          title={row.description || label}
          css={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing.xs,
            flex: 1,
            minWidth: 0,
            padding: 0,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'inherit',
            font: 'inherit',
          }}
          data-testid="project-toggle"
        >
          {row.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          {row.collapsed ? <FolderIcon /> : <FolderOpenIcon />}
          <Typography.Text
            bold
            color={row.name === UNASSIGNED ? 'secondary' : undefined}
            css={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {label}
          </Typography.Text>
          <Typography.Text color="secondary">{row.count}</Typography.Text>
        </button>
        {row.registered && (
          <Tooltip
            componentId="mlflow.experiment_list_view.new_experiment_button.tooltip"
            content={`New experiment in ${row.name}`}
          >
            <Button
              type="link"
              componentId="mlflow.experiment_list_view.new_experiment_button"
              icon={<PlusCircleIcon />}
              onClick={this.handleCreateExperiment(row.name)}
              data-testid="create-experiment-button"
              size="small"
            />
          </Tooltip>
        )}
        {row.registered && row.count === 0 && (
          <Tooltip componentId="mlflow.experiment_list_view.delete_project_button.tooltip" content="Delete project">
            <Button
              type="link"
              componentId="mlflow.experiment_list_view.delete_project_button"
              icon={<TrashIcon />}
              onClick={() => this.setState({ deleteProjectName: row.name })}
              data-testid="delete-project-button"
              size="small"
            />
          </Tooltip>
        )}
      </div>
    );
  };

  renderExperimentRow = (item: ExperimentEntity, key: string, style: React.CSSProperties) => {
    const { activeExperimentIds } = this.props;
    const isActive = activeExperimentIds.includes(item.experimentId);
    const dataTestId = isActive ? 'active-experiment-list-item' : 'experiment-list-item';
    const { theme } = this.props.designSystemThemeApi;
    // Clicking the link removes all checks and marks other experiments
    // as not active.
    return (
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          paddingLeft: theme.spacing.lg,
          paddingRight: theme.spacing.xs,
          borderLeft: isActive ? `solid ${theme.colors.primary}` : 'solid transparent',
          borderLeftWidth: 4,
          backgroundColor: isActive ? theme.colors.actionDefaultBackgroundPress : 'transparent',
          fontSize: theme.typography.fontSizeBase,
          svg: {
            width: 14,
            height: 14,
          },
        }}
        data-testid={dataTestId}
        key={key}
        style={style}
      >
        <Checkbox
          componentId="mlflow.experiment_list_view.check_box"
          id={item.experimentId}
          key={item.experimentId}
          onChange={(isChecked) => this.handleCheck(isChecked, item.experimentId)}
          isChecked={isActive}
          data-testid={`${dataTestId}-check-box`}
        />
        <Link
          className="experiment-link"
          css={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}
          to={Routes.getExperimentPageRoute(item.experimentId)}
          onClick={() => this.setState({ checkedKeys: [item.experimentId] })}
          title={item.name}
          data-testid={`${dataTestId}-link`}
        >
          {item.name}
        </Link>
        <Tooltip componentId="mlflow.experiment_list_view.rename_experiment_button.tooltip" content="Rename experiment">
          <Button
            type="link"
            componentId="mlflow.experiment_list_view.rename_experiment_button"
            icon={<PencilIcon />}
            onClick={this.handleRenameExperiment(item.experimentId, item.name)}
            data-testid="rename-experiment-button"
            size="small"
          />
        </Tooltip>
        <Tooltip componentId="mlflow.experiment_list_view.delete_experiment_button.tooltip" content="Delete experiment">
          <Button
            type="link"
            componentId="mlflow.experiment_list_view.delete_experiment_button"
            icon={<TrashIcon />}
            onClick={this.handleDeleteExperiment(item.experimentId, item.name)}
            data-testid="delete-experiment-button"
            size="small"
          />
        </Tooltip>
      </div>
    );
  };

  renderListItem: ListRowRenderer = ({ index, key, style, parent }) => {
    // Use the parents props to index.
    const row: ListRow = parent.props['data'][index];
    return row.kind === 'project'
      ? this.renderProjectRow(row, key, style)
      : this.renderExperimentRow(row.experiment, key, style);
  };

  unHide = () => this.setState({ hidden: false });
  hide = () => this.setState({ hidden: true });

  render() {
    const { hidden } = this.state;
    const { activeExperimentIds, designSystemThemeApi, projects = [] } = this.props;
    const { theme } = designSystemThemeApi;

    if (hidden) {
      return (
        <Tooltip content="Show project list" componentId="mlflow.experiment_list_view.show_experiments.tooltip">
          <Button
            componentId="mlflow.experiment_list_view.show_experiments"
            icon={<CaretDownSquareIcon />}
            onClick={this.unHide}
            css={{ svg: { transform: 'rotate(-90deg)' } }}
            title="Show project list"
          />
        </Tooltip>
      );
    }

    const { searchInput } = this.state;
    const rows = this.buildRows();

    return (
      <div
        id="experiment-list-outer-container"
        css={{
          boxSizing: 'border-box',
          height: '100%',
          marginLeft: '24px',
          marginRight: '8px',
          paddingRight: '16px',
          width: '100%',
          // Ensure it displays experiment names for smaller screens, but don't
          // take more than 20% of the screen.
          minWidth: 'max(280px, 20vw)',
          maxWidth: '20vw',
          display: 'grid',
          gridTemplateRows: 'auto auto 1fr',
        }}
      >
        <CreateExperimentModal
          isOpen={this.state.createExperimentProject !== undefined}
          onClose={this.handleCloseCreateExperimentModal}
          project={this.state.createExperimentProject ?? ''}
        />
        <DeleteExperimentModal
          isOpen={this.state.showDeleteExperimentModal}
          onClose={this.handleCloseDeleteExperimentModal}
          activeExperimentIds={activeExperimentIds}
          experimentId={this.state.selectedExperimentId}
          experimentName={this.state.selectedExperimentName}
        />
        <RenameExperimentModal
          isOpen={this.state.showRenameExperimentModal}
          onClose={this.handleCloseRenameExperimentModal}
          experimentId={this.state.selectedExperimentId}
          experimentName={this.state.selectedExperimentName}
        />
        {this.state.showCreateProjectModal && (
          <CreateProjectModal
            existingNames={projects.map((project) => project.name)}
            onClose={() => this.setState({ showCreateProjectModal: false })}
            onCreated={this.handleProjectsChanged}
          />
        )}
        {this.state.deleteProjectName !== undefined && (
          <DeleteProjectModal
            name={this.state.deleteProjectName}
            onClose={() => this.setState({ deleteProjectName: undefined })}
            onDeleted={this.handleProjectsChanged}
          />
        )}
        <div
          css={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: theme.spacing.sm,
          }}
        >
          <Typography.Title level={2} style={{ margin: 0 }}>
            Projects
          </Typography.Title>
          <div>
            <Tooltip componentId="mlflow.experiment_list_view.new_project_button.tooltip" content="New project">
              <Button
                componentId="mlflow.experiment_list_view.new_project_button"
                icon={<PlusCircleIcon />}
                onClick={() => this.setState({ showCreateProjectModal: true })}
                title="New Project"
                data-testid="create-project-button"
              />
            </Tooltip>
            <Tooltip componentId="mlflow.experiment_list_view.hide_button.tooltip" content="Hide project list">
              <Button
                componentId="mlflow.experiment_list_view.hide_button"
                icon={<CaretDownSquareIcon />}
                onClick={this.hide}
                css={{ svg: { transform: 'rotate(90deg)' } }}
                title="Hide project list"
              />
            </Tooltip>
          </div>
        </div>
        <Input
          componentId="mlflow.experiment_list_view.search_input"
          placeholder="Search projects and experiments"
          aria-label="search projects and experiments"
          value={searchInput}
          onChange={this.handleSearchInputChange}
          data-testid="search-experiment-input"
        />
        <div css={{ marginTop: theme.spacing.xs }}>
          <AutoSizer>
            {({ width, height }) => (
              <VList
                rowRenderer={this.renderListItem}
                data={rows}
                ref={this.bindListRef}
                rowHeight={32}
                overscanRowCount={10}
                height={height}
                width={width}
                rowCount={rows.length}
              />
            )}
          </AutoSizer>
        </div>
      </div>
    );
  }
}

export default withRouterNext(WithDesignSystemThemeHoc(ExperimentListView));
