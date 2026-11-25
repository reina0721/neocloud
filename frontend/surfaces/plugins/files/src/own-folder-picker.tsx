'use client';
import { useEffect, useRef, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { DialogSurface } from '@clouddrive/ui-adapter/overlays';
import { FilesError, type FileListing } from '../../../src/files/model';
import { useFiles, type ImageCopyDestinationProps } from '../../../src/files/runtime';

import { NumberedFilePagination } from './file-pagination';

const folderPageSize = 20;

/** 目的地与访问根目录共用分页和读取就绪状态。 */
export function OwnFolderPicker({
  value,
  onChange,
  onListing,
  purpose = 'destination',
}: {
  value: string;
  onChange: (parent: string) => void;
  onListing: (listing: FileListing | undefined) => void;
  purpose?: 'destination' | 'access';
}) {
  const port = useFiles();
  const { t } = useFrontendTranslation();
  const [cursor, setCursor] = useState({ parent: value, page: 1 });
  const [result, setResult] = useState<{ parent: string; page: number; listing: FileListing }>();
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  const pending = useRef<AbortController>(undefined);
  const page = cursor.parent === value ? cursor.page : 1;
  const listing = result?.parent === value && result.page === page ? result.listing : undefined;
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void port
      .list(
        {
          parent: value,
          category: '',
          trash: false,
          search: '',
          sort: 'name',
          desc: false,
          filters: { scope: 'folder', kinds: ['folder'] },
          page,
          pageSize: folderPageSize,
        },
        controller.signal,
      )
      .then((listing) => {
        if (controller.signal.aborted) return;
        if (value && listing.breadcrumbs.at(-1)?.id !== value) throw new FilesError('missing');
        if (listing.page !== page || listing.pageSize !== folderPageSize)
          throw new FilesError('unavailable');
        setResult({ parent: value, page, listing });
        setFailure('');
        onListing(listing);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult(undefined);
        setFailure(t('files.errors.' + (error instanceof FilesError ? error.code : 'unavailable')));
        onListing(undefined);
      });
    return () => {
      controller.abort();
      if (pending.current === controller) pending.current = undefined;
    };
  }, [port, value, page, retry, t, onListing]);

  function move(parent: string, nextPage = 1) {
    pending.current?.abort();
    setResult(undefined);
    setFailure('');
    setCursor({ parent, page: nextPage });
    onListing(undefined);
    if (parent !== value) onChange(parent);
    else if (nextPage === page) setRetry((value) => value + 1);
  }

  const access = purpose === 'access';
  const title = t(access ? 'files.connections.root' : 'files.workspace.target');
  const breadcrumbs = listing?.breadcrumbs ?? [];
  const names = breadcrumbs.map(({ name }) => name);
  return (
    <section
      aria-label={title}
      className={access ? 'space-y-3 rounded-control border border-border p-3' : 'space-y-4'}
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {access ? (
        <div className="flex flex-wrap gap-2">
          <Action size="sm" variant="secondary" onPress={() => move('')}>
            /
          </Action>
          {breadcrumbs.map(({ id, name }) => (
            <Action key={id} size="sm" variant="secondary" onPress={() => move(id)}>
              {name}
            </Action>
          ))}
        </div>
      ) : null}
      <p className="break-words text-sm">
        {access ? t('files.connections.selectedRoot') + ': ' : null}
        {listing
          ? access
            ? '/' + names.join('/')
            : [t('files.nav'), ...names].join(' / ')
          : t('files.workspace.unknown')}
      </p>
      {!access && value ? (
        <div className="flex gap-2">
          <Action size="sm" variant="quiet" onPress={() => move('')}>
            {t('files.nav')}
          </Action>
          <Action
            size="sm"
            variant="quiet"
            disabled={!listing}
            onPress={() => move(breadcrumbs.at(-2)?.id ?? '')}
          >
            {t('files.workspace.up')}
          </Action>
        </div>
      ) : null}
      {!listing && !failure ? <p role="status">{t('files.previewLoading')}</p> : null}
      {failure ? (
        <>
          <p role="alert">{failure}</p>
          <Action size="sm" variant="secondary" onPress={() => move(value, page)}>
            {t('files.workspace.retry')}
          </Action>
        </>
      ) : null}
      {listing?.items.length ? (
        <ul className="max-h-60 space-y-2 overflow-y-auto">
          {listing.items.map((entry) => (
            <li key={entry.id}>
              <Action size="sm" variant="quiet" onPress={() => move(entry.id)}>
                {access ? entry.name + '/' : t('files.workspace.openFolder', { name: entry.name })}
              </Action>
            </li>
          ))}
        </ul>
      ) : listing ? (
        <p className="text-sm text-ink-muted">{t('files.workspace.emptyFolders')}</p>
      ) : null}
      {listing && (listing.total > folderPageSize || page > 1) ? (
        <NumberedFilePagination
          page={page}
          pageSize={folderPageSize}
          total={listing.total}
          onPage={(next) => move(value, next)}
        />
      ) : null}
    </section>
  );
}

export function ImageCopyDestinationDialog({
  initialParentId,
  onSelect,
  onClose,
}: ImageCopyDestinationProps) {
  const { t, locale } = useFrontendTranslation();
  const chinese = locale.startsWith('zh');
  const title = chinese ? '选择副本保存位置' : 'Choose copy destination';
  const [parent, setParent] = useState(initialParentId);
  const [listing, setListing] = useState<FileListing>();
  return (
    <DialogSurface
      triggerLabel={title}
      title={title}
      description={
        chinese
          ? '选择本人文件夹，副本会使用导出设置中的名称。'
          : 'Select a folder. The copy uses the name in export settings.'
      }
      cancelLabel={t('files.cancel')}
      confirmLabel={t('files.workspace.chooseHere')}
      confirmDisabled={!listing}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={() => {
        if (!listing) return;
        onSelect({
          id: parent,
          path: [t('files.nav'), ...listing.breadcrumbs.map(({ name }) => name)].join(' / '),
        });
      }}
    >
      <OwnFolderPicker value={parent} onChange={setParent} onListing={setListing} />
    </DialogSurface>
  );
}
