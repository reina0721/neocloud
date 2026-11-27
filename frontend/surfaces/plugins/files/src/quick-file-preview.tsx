'use client';

import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { IconAction } from '@neocloud/ui-adapter/icon-action';
import { DialogSurface } from '@neocloud/ui-adapter/overlays';
import { ChevronLeft, ChevronRight, Download, File } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useProductAccess } from '../../../src/identity/runtime';
import { FilesError, type FileEntry } from '../../../src/files/model';
import { useReaderWorkspace } from './reader-workspace-context';
import type { useQuickFilePreview } from './use-quick-file-preview';

const TextQuickPreview = lazy(() =>
  import('./text-quick-preview').then((module) => ({ default: module.TextQuickPreview })),
);
const PdfPreview = lazy(() =>
  import('./pdf-dialog').then((module) => ({ default: module.PdfPreview })),
);
const QuickPreviewMedia = lazy(() =>
  import('./quick-preview-media').then((module) => ({ default: module.QuickPreviewMedia })),
);

export function QuickFilePreview({
  controller,
  download,
}: {
  controller: ReturnType<typeof useQuickFilePreview>;
  download: (entry: FileEntry) => void;
}) {
  const { t } = useFrontendTranslation();
  const { promoteReader } = useReaderWorkspace();
  const { data: access } = useProductAccess();
  const canWrite = Boolean(access?.nativePermissions?.includes('files:write'));
  const frame = controller.preview;
  if (!frame) return null;
  const { session, entry, application, id, error, signal, contentReady } = frame;
  const kind = application === 'markdown' ? 'text' : (application ?? 'pending');
  const name = entry?.name ?? t('files.quickPreview.title');
  const loading = (
    <div className="flex min-h-24 items-center gap-3 p-4" role="status">
      <File className="size-5 shrink-0 text-ink-muted" aria-hidden="true" />
      {t('files.previewLoading')}
    </div>
  );
  const failureKey = error instanceof FilesError ? error.code : 'unavailable';
  const failureText =
    (kind === 'image' || kind === 'video') && failureKey === 'unsupported'
      ? t('files.mediaUnsupported')
      : (kind === 'image' || kind === 'video') && failureKey === 'large'
        ? t('files.mediaTooLarge')
        : failureKey === 'unsupported' && kind === 'pending'
          ? t('files.quickPreview.unsupported')
          : t(`files.errors.${failureKey}`);
  const needsRender = frame.open && entry && session && application && error === undefined;
  return (
    <DialogSurface
      triggerLabel={t('files.quickPreview.title')}
      title={name}
      description=""
      cancelLabel={t('files.close')}
      layout="preview"
      size="fullscreen"
      isOpen={frame.open}
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
      onExited={controller.onExited}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        if (!(event.target instanceof Element) || event.target.closest('[data-file-preview-body]'))
          return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        controller.move(event.key === 'ArrowLeft' ? -1 : 1);
      }}
      headerAction={
        <>
          {canWrite &&
          entry &&
          application &&
          session?.kind === 'text' &&
          contentReady &&
          frame.textEditable &&
          error === undefined ? (
            <Action
              size="sm"
              variant="quiet"
              onPress={() =>
                controller.promote((history) => promoteReader(entry, application, session, history))
              }
            >
              {t('files.quickPreview.edit')}
            </Action>
          ) : null}
          {entry && application ? (
            <IconAction label={t('files.download')} onPress={() => download(entry)} size="sm">
              <Download />
            </IconAction>
          ) : null}
          <IconAction
            label={t('files.quickPreview.previous')}
            disabled={!controller.canPrevious}
            onPress={() => controller.move(-1)}
            size="sm"
          >
            <ChevronLeft />
          </IconAction>
          <IconAction
            label={t('files.quickPreview.next')}
            disabled={!controller.canNext}
            onPress={() => controller.move(1)}
            size="sm"
          >
            <ChevronRight />
          </IconAction>
        </>
      }
    >
      <div className="surface-file-quick-preview" data-kind={kind} data-file-quick-preview="">
        <div className="surface-file-quick-preview-stage" data-file-preview-stage="">
          <div
            key={id}
            className={`surface-file-quick-preview-content ${contentReady ? 'surface-file-quick-preview-ready' : ''}`}
            data-file-preview-body=""
            data-kind={kind}
            data-preview-status={error !== undefined ? 'error' : contentReady ? 'ready' : 'loading'}
            tabIndex={session?.kind === 'text' && contentReady ? 0 : undefined}
          >
            {error !== undefined ? (
              <div className="space-y-3 p-4">
                <p role="alert">{failureText}</p>
                <Action onPress={controller.retry}>{t('files.retry')}</Action>
              </div>
            ) : needsRender ? (
              <Suspense fallback={loading}>
                {session.kind === 'text' ? (
                  <TextQuickPreview
                    entry={entry}
                    markdown={application === 'markdown'}
                    maxBytes={session.maxBytes}
                    signal={signal}
                    pending={loading}
                    {...(frame.textEditable === undefined
                      ? {}
                      : { textEditable: frame.textEditable })}
                    onReady={(detail) => controller.ready(id, detail)}
                    onFailure={(failure) => controller.fail(id, failure)}
                  />
                ) : session.kind === 'pdf' ? (
                  <PdfPreview
                    entry={session.entry}
                    limits={session.limits}
                    onClose={controller.close}
                    onReady={() => controller.ready(id)}
                    {...(canWrite
                      ? {
                          onAnnotate: (initialPosition) =>
                            controller.promote((history) =>
                              promoteReader(
                                entry,
                                application,
                                { ...session, initialPosition },
                                history,
                              ),
                            ),
                        }
                      : {})}
                  />
                ) : session.kind === 'media' ? (
                  <QuickPreviewMedia
                    session={session}
                    canEditImage={canWrite}
                    onPromote={(full) =>
                      controller.promote((history) =>
                        promoteReader(entry, application, full, history),
                      )
                    }
                    onDownload={() => download(entry)}
                    onReady={() => controller.ready(id)}
                    onFailure={(failure) => controller.fail(id, failure)}
                  />
                ) : null}
              </Suspense>
            ) : frame.open ? (
              loading
            ) : null}
          </div>
        </div>
      </div>
    </DialogSurface>
  );
}
