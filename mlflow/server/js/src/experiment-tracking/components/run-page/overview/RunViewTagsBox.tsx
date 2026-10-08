import { Button, PencilIcon, Spinner, Tooltip, useDesignSystemTheme } from '@databricks/design-system';
import { useEditKeyValueTagsModal } from '../../../../common/hooks/useEditKeyValueTagsModal';
import { KeyValueEntity } from '../../../types';
import { KeyValueTag } from '../../../../common/components/KeyValueTag';
import { FormattedMessage, useIntl } from 'react-intl';
import { values } from 'lodash';
import { useDispatch } from 'react-redux';
import { ThunkDispatch } from '../../../../redux-types';
import { setRunTagsBulkApi } from '../../../actions';
import { useMemo } from 'react';

const RUN_TAG_KEYS = ['run_num', 'base_run', 'change', 'model'];

/**
 * Displays run tags cell in run detail overview.
 */
export const RunViewTagsBox = ({
  runUuid,
  tags,
  onTagsUpdated,
}: {
  runUuid: string;
  tags: Record<string, KeyValueEntity>;
  onTagsUpdated: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const dispatch = useDispatch<ThunkDispatch>();
  const intl = useIntl();

  const visibleTagEntities = useMemo(
    () => values(tags).filter(({ key }) => RUN_TAG_KEYS.includes(key)),
    [tags],
  );

  const { EditTagsModal, showEditTagsModal, isLoading } = useEditKeyValueTagsModal({
    valueRequired: true,
    allAvailableTags: RUN_TAG_KEYS,
    saveTagsHandler: async (_, existingTags, newTags) => {
      if (newTags.some(({ key }) => !RUN_TAG_KEYS.includes(key))) {
        throw new Error('Run tags must be run_num, base_run, change, or model.');
      }
      for (const { key, value } of newTags) {
        if (key === 'run_num' && !/^r[1-9]\d*$/.test(value)) {
          throw new Error('run_num must use r followed by a positive number without leading zeros.');
        }
        // A value stored before base_run held run numbers stays editable around; a changed one must comply.
        const isUnchanged = existingTags.some((tag) => tag.key === key && tag.value === value);
        if (key === 'base_run' && !isUnchanged && !/^(none|r[1-9]\d*(,r[1-9]\d*)*)$/.test(value)) {
          throw new Error('base_run must be none or run numbers such as r12, separated by commas.');
        }
        if (['change', 'model'].includes(key) && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value)) {
          throw new Error(`${key} must use lowercase words or numbers separated by underscores.`);
        }
      }
      await dispatch(setRunTagsBulkApi(runUuid, existingTags, newTags));
      onTagsUpdated();
    },
  });

  const showEditModal = () => {
    showEditTagsModal({ tags: visibleTagEntities });
  };

  const editTagsLabel = intl.formatMessage({
    defaultMessage: 'Edit tags',
    description: "Run page > Overview > Tags cell > 'Edit' button label",
  });

  return (
    <div
      css={{
        paddingTop: theme.spacing.xs,
        paddingBottom: theme.spacing.xs,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        '> *': {
          marginRight: '0 !important',
        },
        gap: theme.spacing.xs,
      }}
    >
      {visibleTagEntities.length < 1 ? (
        <Button
          componentId="mlflow.run_details.overview.tags.add_button"
          size="small"
          type="tertiary"
          onClick={showEditModal}
        >
          <FormattedMessage
            defaultMessage="Add tags"
            description="Run page > Overview > Tags cell > 'Add' button label"
          />
        </Button>
      ) : (
        <>
          {visibleTagEntities.map((tag) => (
            <KeyValueTag tag={tag} key={`${tag.key}-${tag.value}`} enableFullViewModal css={{ marginRight: 0 }} />
          ))}
          <Tooltip componentId="mlflow.run_details.overview.tags.edit_button.tooltip" content={editTagsLabel}>
            <Button
              componentId="mlflow.run_details.overview.tags.edit_button"
              aria-label={editTagsLabel}
              size="small"
              icon={<PencilIcon />}
              onClick={showEditModal}
            />
          </Tooltip>
        </>
      )}
      {isLoading && <Spinner size="small" />}
      {EditTagsModal}
    </div>
  );
};
