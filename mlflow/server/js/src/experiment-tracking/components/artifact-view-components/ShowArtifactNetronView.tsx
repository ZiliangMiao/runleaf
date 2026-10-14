/**
 * Netron model view: the tracking server serves Netron under netron/, which fetches the model artifact from
 * this same origin; the view embeds it and links to a full tab.
 * Naming: build* constructs URLs.
 */
import { Button, NewWindowIcon, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { getArtifactLocationUrl, getLoggedModelArtifactLocationUrl } from '../../../common/utils/ArtifactUtils';
import { getAjaxUrl } from '../../../common/utils/FetchUtils';
import { getBasename } from '../../../common/utils/FileUtils';
import type { LoggedModelArtifactViewerProps } from './ArtifactViewComponents.types';

const ONE_MIB = 1024 * 1024;

/** Build the Netron page URL that opens one artifact; Netron picks the format from the identifier's extension. */
export const buildNetronUrl = (artifactUrl: string, path: string, base: string = window.location.href) => {
  const model = new URL(getAjaxUrl(artifactUrl), base).toString();
  const page = new URL('netron/index.html', base);
  page.search = new URLSearchParams({ url: model, identifier: getBasename(path) }).toString();
  return page.toString();
};

type ShowArtifactNetronViewProps = {
  runUuid: string;
  path: string;
  size?: number;
} & LoggedModelArtifactViewerProps;

const ShowArtifactNetronView = ({
  runUuid,
  path,
  size,
  isLoggedModelsMode,
  loggedModelId,
}: ShowArtifactNetronViewProps) => {
  const { theme } = useDesignSystemTheme();
  const artifactUrl =
    isLoggedModelsMode && loggedModelId
      ? getLoggedModelArtifactLocationUrl(path, loggedModelId)
      : getArtifactLocationUrl(path, runUuid);
  const netronUrl = buildNetronUrl(artifactUrl, path);
  return (
    <div css={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing.sm,
          padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
          borderBottom: `1px solid ${theme.colors.border}`,
        }}
      >
        <Typography.Text color="secondary" css={{ flex: 1 }}>
          Model graph rendered by Netron
          {size !== undefined && ` · ${(size / ONE_MIB).toFixed(1)} MiB are loaded into the browser`}
        </Typography.Text>
        <Button
          componentId="mlflow.artifacts.netron.open_tab"
          icon={<NewWindowIcon />}
          size="small"
          href={netronUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in new tab
        </Button>
      </div>
      <iframe
        key={netronUrl}
        title={`Netron: ${getBasename(path)}`}
        src={netronUrl}
        css={{ flex: 1, width: '100%', minHeight: 480, border: 'none' }}
        data-testid="netron-artifact-view"
      />
    </div>
  );
};

export default ShowArtifactNetronView;
