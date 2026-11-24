'use client';

import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { useReaderWorkspace } from '../../src/reader-workspace-context';

export default function FileViewerRoute() {
  const { t } = useFrontendTranslation();
  const { viewerPending, viewerError, returnToFiles } = useReaderWorkspace();
  return (
    <div className="grid min-h-full place-items-center">
      <div className="space-y-3 text-center">
        <p role={viewerError ? 'alert' : 'status'}>
          {viewerError || t(viewerPending ? 'files.previewLoading' : 'files.viewer.unavailable')}
        </p>
        <Action variant="secondary" onPress={returnToFiles}>
          {t('files.viewer.back')}
        </Action>
      </div>
    </div>
  );
}
