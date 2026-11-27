'use client';
import { lazy, Suspense } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { DialogSurface } from '@neocloud/ui-adapter/overlays';
import { FileMedia, type FileMediaProps } from '../../../src/files/runtime';
import type { FileEntry } from '../../../src/files/model';
import type { OpenReaderSession } from './file-reader-session';
import { ReaderSurface } from './reader-surface';
import { useReaderSurface } from './reader-surface-context';
import { fileApplicationName, type FileApplicationID } from '../../../src/files/file-applications';
import { ImageCopyDestinationDialog } from './own-folder-picker';
import { TextDialog } from './text-dialog';
import type { FileReaderController } from './use-file-reader';
const PdfDialog = lazy(() =>
  import('./pdf-dialog').then((module) => ({ default: module.PdfDialog })),
);
const EpubDialog = lazy(() =>
  import('./epub-dialog').then((module) => ({ default: module.EpubDialog })),
);
const ArchiveDialog = lazy(() =>
  import('./archive-dialog').then((module) => ({ default: module.ArchiveDialog })),
);
const WebFilePreviewDialog = lazy(() =>
  import('./web-file-preview-dialog').then((module) => ({ default: module.WebFilePreviewDialog })),
);
const DrawioDialog = lazy(() => import('./drawio-dialog'));

/** 单个阅读会话的呈现边界；真正的媒体和编辑资源仍由各 reader / Host 释放。 */
export function FileReader({
  session,
  close,
  download,
  saved,
  changed,
  moveImage,
  refreshPublishedImage,
  playback,
  replaceWithBuiltIn,
}: {
  session: OpenReaderSession;
  close: () => void;
  download: (entry: FileEntry) => void;
  saved: () => void;
  changed: () => void;
  moveImage: (delta: -1 | 1) => void;
  refreshPublishedImage: (entry: FileEntry, signal: AbortSignal) => Promise<void>;
  playback: FileMediaProps['playback'] | undefined;
  replaceWithBuiltIn: (application: FileApplicationID, session: OpenReaderSession) => void;
}) {
  const { t, locale } = useFrontendTranslation();
  const surface = useReaderSurface();
  const textEditor = session?.kind === 'text' ? session : undefined;
  const drawio = session?.kind === 'drawio' ? session : undefined;
  const pdfPreview = session?.kind === 'pdf' ? session : undefined;
  const epubEntry = session?.kind === 'epub' ? session.entry : undefined;
  const archiveEntry = session?.kind === 'archive' ? session.entry : undefined;
  const mediaPreview = session?.kind === 'media' ? session : undefined;
  const webPreview = session?.kind === 'web' ? session : undefined;
  const album = mediaPreview?.album;
  const imagePreview = album !== undefined;
  const videoPreview =
    mediaPreview?.videoPlaylist || mediaPreview?.entry.mediaType.startsWith('video/');
  return (
    <>
      {textEditor ? (
        <TextDialog
          {...textEditor}
          {...(textEditor.request.mode === 'edit'
            ? {
                onDownload: () => {
                  if (textEditor.request.mode === 'edit') void download(textEditor.request.entry);
                },
              }
            : {})}
          onClose={() => close()}
          onSaved={saved}
        />
      ) : null}
      {drawio ? (
        <Suspense fallback={<p role="status">{t('files.mediaLoading')}</p>}>
          <DrawioDialog {...drawio} onClose={() => close()} onSaved={changed} />
        </Suspense>
      ) : null}
      {pdfPreview ? (
        <Suspense fallback={<p role="status">{pdfPreview.entry.name}</p>}>
          <PdfDialog {...pdfPreview} onClose={() => close()} />
        </Suspense>
      ) : null}
      {epubEntry ? (
        <Suspense fallback={<p role="status">{epubEntry.name}</p>}>
          <EpubDialog
            key={`${epubEntry.id}:${epubEntry.contentRevision}`}
            entry={epubEntry}
            onClose={() => close()}
            onDownload={() => void download(epubEntry)}
          />
        </Suspense>
      ) : null}
      {mediaPreview ? (
        <ReaderSurface
          triggerLabel={t('files.mediaPreview')}
          title={mediaPreview.entry.name}
          description={t('files.mediaPreview')}
          cancelLabel={t('files.close')}
          size={videoPreview || imagePreview ? 'cover' : 'lg'}
          layout={videoPreview || imagePreview ? 'workspace' : 'standard'}
          isOpen
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          <div className={videoPreview ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-4'}>
            {album ? (
              // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions -- 事件只从可聚焦的导航按钮冒泡。
              <div
                role="group"
                aria-label={locale.startsWith('zh') ? '照片导航' : 'Photo navigation'}
                className="flex flex-wrap items-center gap-2"
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                  event.preventDefault();
                  moveImage(event.key === 'ArrowLeft' ? -1 : 1);
                }}
              >
                <Action
                  size="sm"
                  variant="secondary"
                  disabled={album.index === 0}
                  onPress={() => moveImage(-1)}
                >
                  {locale.startsWith('zh') ? '上一张' : 'Previous photo'}
                </Action>
                <p role="status" className="text-sm text-ink-muted">
                  {album.index + 1} / {album.entries.length}
                </p>
                <Action
                  size="sm"
                  variant="secondary"
                  disabled={album.index + 1 >= album.entries.length}
                  onPress={() => moveImage(1)}
                >
                  {locale.startsWith('zh') ? '下一张' : 'Next photo'}
                </Action>
              </div>
            ) : null}
            {mediaPreview.savedImageVersion ? (
              <p role="status" className="text-sm text-ink-muted">
                {locale.startsWith('zh')
                  ? '已保存图片新版本。'
                  : 'The new image version was saved.'}
              </p>
            ) : null}
            <FileMedia
              key={mediaPreview.entry.id + ':' + mediaPreview.entry.contentRevision}
              entry={mediaPreview.entry}
              mode="preview"
              maxBytes={mediaPreview.maxBytes}
              {...(mediaPreview.videoHandoff ? { resumeVideo: mediaPreview.videoHandoff } : {})}
              {...(playback ? { playback } : {})}
              {...(mediaPreview.videoPlaylist
                ? { videoPlaylist: { download: () => void download(mediaPreview.entry) } }
                : {})}
              {...(mediaPreview.entry.kind === 'file' && mediaPreview.entry.trashedAt === null
                ? {
                    imageEditing: {
                      entry: mediaPreview.entry,
                      ...(mediaPreview.openImageEditor ? { openOnMount: true } : {}),
                      ...(surface?.draft ? { draft: surface.draft } : {}),
                      ...(surface
                        ? {
                            workspace: {
                              visible: surface.presentation === 'reader',
                              minimize: surface.minimize,
                              close: surface.close,
                              interceptClose: surface.interceptClose,
                              onDraftState: surface.setDraftState,
                            },
                          }
                        : {}),
                      destinationPicker: ImageCopyDestinationDialog,
                      onVersionPublished: refreshPublishedImage,
                    },
                  }
                : {})}
            />
          </div>
        </ReaderSurface>
      ) : null}
      {archiveEntry ? (
        <Suspense fallback={<p role="status">{t('files.previewLoading')}</p>}>
          <ArchiveDialog entry={archiveEntry} onClose={() => close()} onChanged={changed} />
        </Suspense>
      ) : null}
      {webPreview ? (
        <Suspense fallback={<p role="status">{t('files.previewLoading')}</p>}>
          <WebFilePreviewDialog
            entry={webPreview.entry}
            application={webPreview.application}
            onClose={() => close()}
            replaceWithBuiltIn={replaceWithBuiltIn}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export function FileApplicationSelection({ reader }: { reader: FileReaderController }) {
  const { t, locale } = useFrontendTranslation();
  const chinese = locale.startsWith('zh');
  const openWithLabel = chinese ? '打开方式' : 'Open with';
  const noApplicationLabel = chinese
    ? '此文件在当前设备上没有可用的浏览应用。'
    : 'No viewer is available for this file on this device.';

  const applicationPicker = reader.picker;
  return (
    <>
      {applicationPicker ? (
        <DialogSurface
          triggerLabel={openWithLabel}
          title={openWithLabel}
          description={applicationPicker.entry.name}
          cancelLabel={t('files.close')}
          isOpen
          onOpenChange={(open) => {
            if (!open) {
              reader.cancelPending();
            }
          }}
        >
          <div className="space-y-4">
            {applicationPicker.error ? (
              <p role="alert">{applicationPicker.error}</p>
            ) : !applicationPicker.options ? (
              <p role="status">{t('files.previewLoading')}</p>
            ) : applicationPicker.options.length === 0 && !applicationPicker.webOptions?.length ? (
              <p role="status">{noApplicationLabel}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {applicationPicker.options.map((id) => (
                  <Action
                    key={id}
                    variant="secondary"
                    onPress={() => {
                      reader.choose(id);
                    }}
                  >
                    {fileApplicationName(id, chinese)}
                  </Action>
                ))}
                {applicationPicker.webOptions?.map((application) => (
                  <Action
                    key={application.id}
                    variant="secondary"
                    onPress={() => {
                      reader.choose(application);
                    }}
                  >
                    {application.name}
                  </Action>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {applicationPicker.error ? (
                <Action
                  variant="secondary"
                  onPress={() => void reader.open(applicationPicker.entry, 'choose')}
                >
                  {t('files.retry')}
                </Action>
              ) : null}
              <Action
                variant="secondary"
                onPress={() => void reader.download(applicationPicker.entry)}
              >
                {t('files.download')}
              </Action>
            </div>
          </div>
        </DialogSurface>
      ) : null}
    </>
  );
}
