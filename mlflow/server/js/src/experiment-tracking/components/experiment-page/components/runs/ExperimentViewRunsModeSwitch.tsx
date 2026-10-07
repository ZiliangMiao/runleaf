import { LegacyTabs, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { ExperimentPageViewState } from '../../models/ExperimentPageViewState';
import type { ExperimentViewRunsCompareMode } from '../../../../types';
import { PreviewBadge } from '@mlflow/mlflow/src/shared/building_blocks/PreviewBadge';
import { getExperimentPageDefaultViewMode, useExperimentPageViewMode } from '../../hooks/useExperimentPageViewMode';
import {
  isExperimentLoggedModelsUIEnabled,
  shouldUseRenamedUnifiedTracesTab,
} from '../../../../../common/utils/FeatureUtils';
import { ExperimentPageTabName } from '../../../../constants';
import { useNavigate } from '../../../../../common/utils/RoutingUtils';
import Routes from '../../../../routes';
import { useExperimentPageSearchFacets } from '../../hooks/useExperimentPageSearchFacets';

export interface ExperimentViewRunsModeSwitchProps {
  viewState?: ExperimentPageViewState;
  runsAreGrouped?: boolean;
  hideBorder?: boolean;
  explicitViewMode?: ExperimentViewRunsCompareMode;
  experimentId?: string;
}

/**
 * Allows switching between various modes of the experiment page view.
 * Handles legacy part of the mode switching, based on "compareRunsMode" query parameter.
 * Modern part of the mode switching is handled by <ExperimentViewRunsModeSwitchV2> which works using route params.
 */
export const ExperimentViewRunsModeSwitch = ({ hideBorder = true }: ExperimentViewRunsModeSwitchProps) => {
  const navigate = useNavigate();
  const [, experimentIds] = useExperimentPageSearchFacets();
  const [viewMode, setViewModeInURL] = useExperimentPageViewMode();
  const { classNamePrefix } = useDesignSystemTheme();
  const currentViewMode = viewMode || getExperimentPageDefaultViewMode();
  const validRunsTabModes = shouldUseRenamedUnifiedTracesTab() ? ['TABLE', 'CHART', 'ARTIFACT'] : ['TABLE', 'CHART'];
  const activeTab = validRunsTabModes.includes(currentViewMode) ? 'RUNS' : currentViewMode;

  // Extract experiment ID from the URL but only if it's a single experiment.
  // In case of multiple experiments (compare mode), the experiment ID is undefined.
  const singleExperimentId = experimentIds.length === 1 ? experimentIds[0] : undefined;

  return (
    <LegacyTabs
      dangerouslyAppendEmotionCSS={{
        [`.${classNamePrefix}-tabs-nav`]: {
          marginBottom: 0,
          '::before': {
            display: hideBorder ? 'none' : 'block',
          },
        },
      }}
      activeKey={activeTab}
      onChange={(tabKey) => {
        if (tabKey === 'BENCHMARKS' && singleExperimentId) {
          navigate(Routes.getExperimentPageTabRoute(singleExperimentId, ExperimentPageTabName.Benchmarks));
          return;
        }
        if (tabKey === 'LINEAGE' && singleExperimentId) {
          navigate(Routes.getExperimentPageTabRoute(singleExperimentId, ExperimentPageTabName.Lineage));
          return;
        }
        const newValue = tabKey as ExperimentViewRunsCompareMode | 'RUNS';

        if (activeTab === newValue) {
          return;
        }

        if (newValue === 'RUNS') {
          return setViewModeInURL('TABLE');
        }

        setViewModeInURL(newValue, singleExperimentId);
      }}
    >
      <LegacyTabs.TabPane
        tab={
          <span data-testid="experiment-runs-mode-switch-combined">
            <FormattedMessage
              defaultMessage="Runs"
              description="A button enabling combined runs table and charts mode on the experiment page"
            />
          </span>
        }
        key="RUNS"
      />
      {singleExperimentId && (
        <LegacyTabs.TabPane
          key="LINEAGE"
          tab={
            <FormattedMessage
              defaultMessage="Lineage"
              description="A tab showing parent relationships between experiment runs"
            />
          }
        />
      )}
      {singleExperimentId && (
        <LegacyTabs.TabPane
          key="BENCHMARKS"
          tab={
            <FormattedMessage
              defaultMessage="Benchmarks"
              description="A tab comparing benchmark results within the experiment"
            />
          }
        />
      )}
      {/* Display the "Models" tab if we have only one experiment and the feature is enabled. */}
      {singleExperimentId && isExperimentLoggedModelsUIEnabled() && (
        <LegacyTabs.TabPane
          key="MODELS"
          tab={
            <span data-testid="experiment-runs-mode-switch-models">
              <FormattedMessage
                defaultMessage="Models"
                description="A button navigating to logged models table on the experiment page"
              />
              <PreviewBadge />
            </span>
          }
        />
      )}
    </LegacyTabs>
  );
};
