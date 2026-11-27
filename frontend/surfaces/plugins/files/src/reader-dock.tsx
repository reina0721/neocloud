'use client';

import { useState } from 'react';
import { useFrontendTranslation } from '@neocloud/i18n';
import { IconAction } from '@neocloud/ui-adapter/icon-action';
import { PopoverCard } from '@neocloud/ui-adapter/overlays';
import { FileGlyph, LayoutGrid } from '../../../src/files/icons';
import { FileMedia } from '../../../src/files/runtime';
import type { OpenFile } from './reader-workspace';
import { fileApplicationName, fileApplicationIDs } from '../../../src/files/file-applications';

const thumbnailLimit = 512 * 1024;
const rasterThumbnails = new Set(['image/png', 'image/jpeg']);

export function ReaderDock({
  files,
  onActivate,
  onClose,
  active,
  message,
}: {
  files: readonly OpenFile[];
  onActivate: (item: OpenFile) => void;
  onClose: (item: OpenFile) => void;
  active: string | undefined;
  message: string;
}) {
  const { t, locale } = useFrontendTranslation();
  const [open, setOpen] = useState(false);
  const zh = locale.startsWith('zh');
  const label = t('files.viewer.applications');
  const groups = new Map<string, OpenFile[]>();
  for (const item of files) {
    const id = item.bookmark.application;
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return (
    <div className="file-app-launcher pointer-events-none fixed z-toast">
      {files.length ? (
        <div className="pointer-events-auto relative w-control rounded-action bg-surface-raised shadow-panel">
          <PopoverCard
            title={label}
            triggerLabel={label}
            triggerIcon={<LayoutGrid />}
            closeLabel={t('files.close')}
            size="comfortable"
            placement="top-start"
            isOpen={open}
            onOpenChange={setOpen}
          >
            <div data-file-app-box className="file-app-box h-64 overflow-y-auto sm:h-80">
              {[...groups].map(([id, items]) => {
                const app = fileApplicationIDs.find((choice) => choice === id);
                return (
                  <section key={id} className="mb-3 space-y-1">
                    <h3 className="px-1 text-xs font-semibold text-ink">
                      {app
                        ? fileApplicationName(app, zh)
                        : (items[0]?.applicationLabel ?? (zh ? '网页应用' : 'Web app'))}
                    </h3>
                    <ul className="grid grid-cols-2 gap-2">
                      {items.map((item) => {
                        const entry = item.entry;
                        const name = entry?.name ?? item.blocked ?? t('files.viewer.unavailable');
                        const key = JSON.stringify([item.bookmark.fileId, id]);
                        const thumbnail =
                          entry &&
                          rasterThumbnails.has(entry.mediaType) &&
                          entry.sizeBytes <= thumbnailLimit;
                        return (
                          <li
                            key={key}
                            className={`relative min-w-0 rounded-control border border-border ${active === key ? 'bg-brand-soft' : 'bg-surface-muted'}`}
                          >
                            <button
                              type="button"
                              className="block w-full rounded-control px-2 text-left outline-offset-2 hover:bg-brand/8"
                              onClick={() => {
                                setOpen(false);
                                onActivate(item);
                              }}
                            >
                              <span className="block w-full min-w-0 py-1 text-left" title={name}>
                                <span
                                  className="grid h-16 w-full place-items-center overflow-hidden rounded-control bg-surface-raised"
                                  aria-hidden="true"
                                >
                                  {thumbnail ? (
                                    <FileMedia
                                      entry={entry}
                                      mode="thumbnail"
                                      alt=""
                                      maxBytes={thumbnailLimit}
                                    />
                                  ) : (
                                    <FileGlyph
                                      kind="file"
                                      mediaType={entry?.mediaType ?? ''}
                                      size="small"
                                    />
                                  )}
                                </span>
                                <span className="mt-1 block truncate pr-6 text-xs text-ink">
                                  {name}
                                </span>
                                {item.draftState !== 'clean' ? (
                                  <span className="block truncate text-xs">
                                    {t('files.viewer.draft')}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                            <div className="absolute bottom-0 right-0">
                              <IconAction
                                size="sm"
                                label={t('files.viewer.closeFile', { name })}
                                onPress={() => {
                                  setOpen(false);
                                  onClose(item);
                                }}
                              >
                                <span aria-hidden="true">×</span>
                              </IconAction>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          </PopoverCard>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-1 -top-1 min-w-5 rounded-action bg-brand px-1 text-center text-xs text-on-brand"
          >
            {files.length}
          </span>
        </div>
      ) : null}
      {message && !open ? (
        <p
          role="status"
          className="absolute bottom-full left-0 mb-2 w-max max-w-xs rounded-panel bg-surface-raised px-3 py-2 text-sm shadow-panel"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
