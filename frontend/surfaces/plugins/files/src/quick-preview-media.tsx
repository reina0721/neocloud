'use client';

import { useCallback, useRef } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { FileMedia, type VideoPlaybackHandoff } from '../../../src/files/runtime';
import type { MediaReaderSession } from './file-reader-session';

export function QuickPreviewMedia({
  session,
  canEditImage,
  onPromote,
  onDownload,
  onReady,
  onFailure,
}: {
  session: MediaReaderSession;
  canEditImage: boolean;
  onPromote: (session: MediaReaderSession) => void;
  onDownload: () => void;
  onReady?: () => void;
  onFailure?: (error: unknown) => void;
}) {
  const { t } = useFrontendTranslation();
  const capture = useRef<() => VideoPlaybackHandoff | undefined>(undefined);
  const registerVideoHandoff = useCallback((value: typeof capture.current) => {
    capture.current = value;
  }, []);
  const video = Boolean(session.videoPlaylist || session.entry.mediaType.startsWith('video/'));
  const editableImage =
    canEditImage &&
    session.entry.trashedAt === null &&
    /^image\/(png|jpeg|webp)(?:;|$)/i.test(session.entry.mediaType);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {video || editableImage ? (
        <div className="flex shrink-0 justify-end">
          <span className="rounded-action bg-surface">
            <Action
              size="sm"
              variant="secondary"
              onPress={() => {
                const videoHandoff = capture.current?.();
                onPromote(
                  video
                    ? videoHandoff
                      ? { ...session, videoHandoff }
                      : session
                    : { ...session, openImageEditor: true },
                );
              }}
            >
              {t(video ? 'files.viewer.focusVideo' : 'files.viewer.editImageCopy')}
            </Action>
          </span>
        </div>
      ) : null}
      <FileMedia
        entry={session.entry}
        mode="preview"
        presentation="quick"
        maxBytes={session.maxBytes}
        {...(onReady ? { onReady } : {})}
        {...(onFailure ? { onFailure } : {})}
        {...(session.videoPlaylist ? { videoPlaylist: { download: onDownload } } : {})}
        {...(video
          ? {
              playback: { presentation: 'reader' },
              registerVideoHandoff,
            }
          : {})}
      />
    </div>
  );
}
