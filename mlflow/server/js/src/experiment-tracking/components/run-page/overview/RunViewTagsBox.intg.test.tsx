import userEvent from '@testing-library/user-event';

import { MockedReduxStoreProvider } from '../../../../common/utils/TestUtils';
import { renderWithIntl, fastFillInput, act, screen, within } from '@mlflow/mlflow/src/common/utils/TestUtils.react18';
import { setRunTagsBulkApi } from '../../../actions';
import { KeyValueEntity } from '../../../types';
import { RunViewTagsBox } from './RunViewTagsBox';
import { DesignSystemProvider } from '@databricks/design-system';

const testRunUuid = 'test-run-uuid';

jest.mock('../../../actions', () => ({
  setRunTagsBulkApi: jest.fn(() => ({ type: 'setRunTagsBulkApi', payload: Promise.resolve() })),
}));

describe('RunViewTagsBox integration', () => {
  const onTagsUpdated = jest.fn();

  function renderTestComponent(existingTags: Record<string, KeyValueEntity> = {}) {
    renderWithIntl(
      <DesignSystemProvider>
        <MockedReduxStoreProvider>
          <RunViewTagsBox onTagsUpdated={onTagsUpdated} runUuid={testRunUuid} tags={existingTags} />,
        </MockedReduxStoreProvider>
      </DesignSystemProvider>,
    );
  }

  beforeEach(() => {
    jest.mocked(setRunTagsBulkApi).mockClear();
    onTagsUpdated.mockClear();
  });

  test('it should display empty tag list and adding a new one', async () => {
    // Render the component, wait to load initial data
    await act(async () => {
      renderTestComponent();
    });

    expect(screen.getByRole('button', { name: 'Add tags' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add tags' }));

    await fastFillInput(within(screen.getByRole('dialog')).getByRole('combobox'), 'model');

    await userEvent.click(screen.getAllByText('model', { exact: true }).pop()!);
    await fastFillInput(screen.getByLabelText('Value'), 'vit_b_16');
    await userEvent.click(screen.getByLabelText('Add tag'));

    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    expect(setRunTagsBulkApi).toBeCalledWith('test-run-uuid', [], [{ key: 'model', value: 'vit_b_16' }]);
    expect(onTagsUpdated).toBeCalled();
  });

  test('should modify already existing tag list', async () => {
    // Render the component, wait to load initial data
    await act(async () => {
      renderTestComponent([
        { key: 'change', value: 'val1' },
        { key: 'base_run', value: 'val2' },
        { key: 'mlflow.existing_tag_3', value: 'val2' },
        { key: 'base_run_id', value: 'obsolete-parent-id' },
      ] as any);
    });

    expect(screen.getByRole('status', { name: 'change' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'base_run' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /existing_tag_3/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'base_run_id' })).not.toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Edit tags' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Edit tags' }));

    const modalBody = screen.getByRole('dialog');

    await userEvent.click(
      within(within(modalBody).getByRole('status', { name: 'change' })).getByRole('button'),
    );

    await fastFillInput(within(screen.getByRole('dialog')).getByRole('combobox'), 'model');

    await userEvent.click(screen.getAllByText('model', { exact: true }).pop()!);
    await fastFillInput(screen.getByLabelText('Value'), 'vit_b_16');
    await userEvent.click(screen.getByLabelText('Add tag'));

    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    expect(setRunTagsBulkApi).toBeCalledWith(
      'test-run-uuid',
      [
        { key: 'change', value: 'val1' },
        { key: 'base_run', value: 'val2' },
      ],
      [
        { key: 'base_run', value: 'val2' },
        { key: 'model', value: 'vit_b_16' },
      ],
    );
    expect(onTagsUpdated).toBeCalled();
  });

  test.each([
    ['base_run_id', 'obsolete-id', 'Run tags must be'],
    ['run_num', 'r01', 'run_num must use'],
    ['model', 'ViT-B-16', 'model must use'],
  ])('rejects invalid tag %s without sending writes', async (key, value, error) => {
    await act(async () => renderTestComponent());
    await userEvent.click(screen.getByRole('button', { name: 'Add tags' }));
    await fastFillInput(within(screen.getByRole('dialog')).getByRole('combobox'), key);
    if (key === 'base_run_id') {
      await userEvent.click(screen.getByText(/Add tag "base_run_id"/));
    } else {
      await userEvent.click(screen.getAllByText(key, { exact: true }).pop()!);
    }
    await fastFillInput(screen.getByLabelText('Value'), value);
    await userEvent.click(screen.getByLabelText('Add tag'));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));
    expect(await screen.findByText(new RegExp(error))).toBeInTheDocument();
    expect(setRunTagsBulkApi).not.toHaveBeenCalled();
    expect(onTagsUpdated).not.toHaveBeenCalled();
  });

  test('should react accordingly when API responds with an error', async () => {
    jest.mocked(setRunTagsBulkApi).mockImplementation(
      () =>
        ({
          type: 'setRunTagsBulkApi',
          payload: Promise.reject(new Error('Some error message')),
        } as any),
    );

    await act(async () => {
      renderTestComponent();
    });

    expect(screen.getByRole('button', { name: 'Add tags' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add tags' }));

    await fastFillInput(within(screen.getByRole('dialog')).getByRole('combobox'), 'model');

    await userEvent.click(screen.getAllByText('model', { exact: true }).pop()!);
    await fastFillInput(screen.getByLabelText('Value'), 'vit_b_16');
    await userEvent.click(screen.getByLabelText('Add tag'));

    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    expect(setRunTagsBulkApi).toBeCalledWith('test-run-uuid', [], [{ key: 'model', value: 'vit_b_16' }]);

    expect(screen.getByText('Some error message')).toBeInTheDocument();
  });
});
