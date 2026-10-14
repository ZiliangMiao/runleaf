/**
 * NOTE: this code file was automatically migrated to TypeScript using ts-migrate and
 * may contain multiple `any` type annotations and `@ts-expect-error` directives.
 * If possible, please improve types while making changes to this file. If the type
 * annotations are already looking good, please remove this comment.
 */

import React, { Component } from 'react';
import { connect } from 'react-redux';
import type { NavigateFunction } from '../../../common/utils/RoutingUtils';
import debounce from 'lodash/debounce';

import Routes from '../../routes';
import { GenericInputModal } from './GenericInputModal';
import { CreateExperimentForm, EXP_NAME_FIELD, ARTIFACT_LOCATION } from './CreateExperimentForm';
import { getExperimentNameValidator } from '../../../common/forms/validations';

import { searchExperimentsApi } from '../../actions';
import { getExperiments } from '../../reducers/Reducers';
import { withRouterNext } from '../../../common/utils/withRouterNext';
import { createProjectExperiment } from '../projects/projectsApi';

type CreateExperimentModalImplProps = {
  isOpen?: boolean;
  onClose: (...args: any[]) => any;
  /** Registered project that will own the experiment. */
  project: string;
  experimentNames: string[];
  createProjectExperiment?: typeof createProjectExperiment;
  searchExperimentsApi: (...args: any[]) => any;
  navigate: NavigateFunction;
};

export class CreateExperimentModalImpl extends Component<CreateExperimentModalImplProps> {
  handleCreateExperiment = async (values: any) => {
    // get values of input fields
    const experimentName = values[EXP_NAME_FIELD];
    const artifactLocation = values[ARTIFACT_LOCATION];
    const create = this.props.createProjectExperiment ?? createProjectExperiment;

    // The experiment list must hold the new experiment before redirecting to its page.
    const newExperimentId = await create(this.props.project, experimentName, artifactLocation);
    await this.props.searchExperimentsApi();

    if (newExperimentId) {
      this.props.navigate(Routes.getExperimentPageRoute(newExperimentId));
    }
  };

  debouncedExperimentNameValidator = debounce(
    getExperimentNameValidator(() => this.props.experimentNames),
    400,
  );

  render() {
    const { isOpen } = this.props;
    return (
      <GenericInputModal
        title={`Create Experiment in ${this.props.project}`}
        okText="Create"
        isOpen={isOpen}
        handleSubmit={this.handleCreateExperiment}
        onClose={this.props.onClose}
      >
        {/* @ts-expect-error TS(2322): Type '{ validator: ((rule: any, value: any, callba... Remove this comment to see the full error message */}
        <CreateExperimentForm validator={this.debouncedExperimentNameValidator} />
      </GenericInputModal>
    );
  }
}

const mapStateToProps = (state: any) => {
  const experiments = getExperiments(state);
  const experimentNames = experiments.map((e) => e.name);
  return { experimentNames };
};

const mapDispatchToProps = {
  searchExperimentsApi,
};

export const CreateExperimentModal = withRouterNext(
  connect(mapStateToProps, mapDispatchToProps)(CreateExperimentModalImpl),
);
