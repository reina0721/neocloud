'use client';

import { useCallback } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { Action } from '@neocloud/ui-adapter/action';
import { FileMediaDock, type useFileMusic } from '../../../src/files/runtime';

export function MediaShelf({
  music,
  video,
  front,
  setFront,
  open,
  setOpen,
}: {
  music: ReturnType<typeof useFileMusic>;
  video: boolean;
  front: 'music' | 'video';
  setFront: (front: 'music' | 'video') => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const { t } = useFrontendTranslation();
  const show = useCallback(() => setOpen(true), [setOpen]);
  const hide = useCallback(() => setOpen(false), [setOpen]);
  const hasMusic = Boolean(music?.active);
  if (!hasMusic && !video) return null;
  const both = hasMusic && video;
  const behind = front === 'music' ? 'video' : 'music';
  return (
    <FileMediaDock
      label={t(front === 'music' ? 'files.viewer.music' : 'files.viewer.video')}
      expandLabel={t(hasMusic ? 'files.viewer.expandMusic' : 'files.viewer.expandVideo')}
      open={open}
      onOpen={show}
      onClose={hide}
      backCard={
        both ? (
          <div className="w-fit rounded-t-control border border-border bg-surface-muted shadow-panel">
            <Action variant="quiet" size="sm" onPress={() => setFront(behind)}>
              {t('files.viewer.showMedia', { name: t('files.viewer.' + behind) })}
            </Action>
          </div>
        ) : undefined
      }
    >
      {(collapse) => (
        <>
          <div hidden={front !== 'music'}>
            {music?.render({
              open: open && front === 'music',
              activate: () => {
                setFront('music');
                show();
              },
              collapse,
            })}
          </div>
          {front === 'video' ? (
            <div aria-hidden="true" className="file-reader-mini-placeholder" />
          ) : null}
        </>
      )}
    </FileMediaDock>
  );
}
