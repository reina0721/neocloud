'use client';
import type { ReactNode } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { CheckboxField } from '@clouddrive/ui-adapter/form-field';
import type { FileEntry } from '../../../src/files/model';
import type { FileIconRule } from '../../../src/files/icon-rules';
import type { FileViewPreferences, FileColumn } from '../../../src/files/view-options';
import { FileGlyph } from '../../../src/files/icons';
import { formatFileBytes } from '../../../src/files/format';
import type { FileAnnotationSummary } from '../../../src/files/annotation-values';
import { TagBadges } from './tag-badges';
import { useFileTime } from './use-file-time';

export type FileSelectionGesture = Readonly<{ extend: boolean; toggle: boolean }>;

const listRow = 'flex min-w-0 items-center gap-2 border-b border-border px-2';
const selectionCell = 'flex w-8 shrink-0 items-center justify-center';
const nameCell = 'flex min-w-0 flex-1 items-center gap-3';
const metadataCell = 'hidden w-20 min-w-0 shrink-0 @xl/file-list:block @2xl/file-list:w-24';
const actionsCell = 'flex w-9 shrink-0 items-center justify-center';
const rowBackground = (target: EventTarget) =>
  target instanceof Element && !target.closest('button, a, input, label, [role="menuitem"]');

export function FileListHeader({
  preferences,
  onSort,
  selection,
}: {
  preferences: FileViewPreferences;
  onSort: (key: FileViewPreferences['sort']) => void;
  selection?: Readonly<{
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  }>;
}) {
  const { t } = useFrontendTranslation();
  const header = (key: FileViewPreferences['sort'], label: string, cell: string) => (
    <div
      key={key}
      role="columnheader"
      aria-sort={
        preferences.sort === key ? (preferences.desc ? 'descending' : 'ascending') : 'none'
      }
      className={cell}
    >
      {key === 'name' ? <span className="w-7 shrink-0" aria-hidden="true" /> : null}
      <div className="min-w-0 [&>button]:min-w-0 [&>button]:justify-start [&>button]:px-0">
        <Action size="sm" variant="quiet" fullWidth onPress={() => onSort(key)}>
          <span className="min-w-0 truncate" title={label}>
            {label}
          </span>
          {preferences.sort === key ? (
            <span aria-hidden="true">{preferences.desc ? '↓' : '↑'}</span>
          ) : null}
        </Action>
      </div>
    </div>
  );
  return (
    <div role="row" className={`${listRow} surface-file-list-heading text-xs text-ink-muted`}>
      <div role="columnheader" className={selectionCell}>
        {selection ? (
          <CheckboxField
            label={t('files.discovery.selectPage')}
            presentation="control-only"
            checked={selection.checked}
            disabled={selection.disabled ?? false}
            onCheckedChange={selection.onCheckedChange}
          />
        ) : (
          <span className="sr-only">{t('files.discovery.selectPage')}</span>
        )}
      </div>
      {header('name', t('files.name'), nameCell)}
      {preferences.columns.map((column) =>
        column === 'kind' ? (
          <div key={column} role="columnheader" className={metadataCell}>
            {t('files.discovery.kind')}
          </div>
        ) : (
          header(column, t(`files.discovery.${column}`), metadataCell)
        ),
      )}
      <div role="columnheader" className={actionsCell}>
        <span className="sr-only">{t('files.discovery.actions')}</span>
      </div>
    </div>
  );
}

export function FileItem({
  entry,
  view,
  columns,
  selected,
  cut,
  tabStop,
  thumbnail,
  actions,
  onChecked,
  onOpen,
  onSelect,
  onFocus,
  onContext,
  annotation,
  iconRule,
  onTag,
  folderClick = 'open',
}: {
  entry: FileEntry;
  view: FileViewPreferences['view'];
  columns: readonly FileColumn[];
  selected: boolean;
  cut: boolean;
  tabStop: boolean;
  thumbnail: ReactNode;
  actions: ReactNode;
  onChecked: (checked: boolean) => void;
  onOpen: () => void;
  onSelect: (gesture: FileSelectionGesture) => void;
  onFocus: () => void;
  onContext: () => void;
  annotation?: FileAnnotationSummary | undefined;
  iconRule?: FileIconRule | undefined;
  onTag: (name: string) => void;
  folderClick?: 'open' | 'select' | undefined;
}) {
  const time = useFileTime();
  const { t } = useFrontendTranslation(),
    isList = view === 'list';
  const kind = t(
    entry.kind === 'file'
      ? 'files.discovery.file'
      : entry.kind === 'folder'
        ? 'files.folder'
        : 'files.navigation.shortcut',
  );
  const title = (
    <button
      type="button"
      id={'file-entry-' + entry.id}
      data-file-entry={entry.id}
      tabIndex={tabStop ? 0 : -1}
      onFocus={onFocus}
      title={entry.name}
      className={`${isList ? 'block truncate' : 'line-clamp-2 break-words [overflow-wrap:anywhere]'} max-w-full text-left text-sm font-medium outline-offset-4 hover:text-brand`}
      onClick={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey)
          onSelect({ extend: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
        else if (entry.kind === 'folder' && folderClick === 'select' && event.detail !== 0)
          onSelect({ extend: false, toggle: false });
        else onOpen();
      }}
      onDoubleClick={() => {
        if (entry.kind === 'folder' && folderClick === 'select') onOpen();
      }}
    >
      {entry.name}
    </button>
  );
  const selection = (
    <CheckboxField
      label={t('files.selectFile', { name: entry.name })}
      presentation="control-only"
      checked={selected}
      onCheckedChange={onChecked}
    />
  );
  const glyph = (
    <FileGlyph
      kind={entry.kind}
      mediaType={entry.mediaType}
      size="small"
      emoji={annotation?.emoji}
      color={annotation?.folderColor}
      rule={iconRule}
    />
  );
  const icon = annotation?.emoji ? glyph : thumbnail || glyph;
  const tags = annotation ? <TagBadges tags={annotation.tags} onTag={onTag} /> : null;
  const expiry = entry.trashExpiresAt ? (
    <p className="mt-1 text-xs text-ink-muted">
      {t('files.trashRetention.expires', { date: time.full(entry.trashExpiresAt) })}
    </p>
  ) : null;
  const columnValue = (column: FileColumn) =>
    column === 'kind'
      ? kind
      : column === 'size'
        ? entry.kind === 'file'
          ? formatFileBytes(entry.sizeBytes)
          : '—'
        : time.date(column === 'created' ? entry.createdAt : entry.updatedAt);
  return (
    // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/no-noninteractive-element-interactions -- 行本身保留表格语义，键盘通过文件名和复选框打开与选择。
    <article
      role={isList ? 'row' : undefined}
      data-file-item={entry.id}
      onClick={(event) => {
        if (isList && rowBackground(event.target)) {
          event.currentTarget
            .querySelector<HTMLButtonElement>('[data-file-entry]')
            ?.focus({ preventScroll: true });
          onSelect({ extend: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
        }
      }}
      onDoubleClick={(event) => {
        if (isList && rowBackground(event.target)) onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContext();
      }}
      data-file-cut={cut || undefined}
      data-selected={selected || undefined}
      data-file-view={view}
      data-file-kind={entry.kind}
      className={`surface-file-item ${isList ? listRow : 'flex w-full min-w-0 flex-col gap-1 self-start rounded-control border border-border/70 px-2 py-1 shadow-none hover:shadow-none'} ${selected ? 'bg-brand-soft' : isList ? 'hover:bg-surface-muted' : 'bg-surface hover:bg-surface-muted/70'} ${cut ? 'opacity-50' : ''}`}
    >
      {isList ? (
        <>
          <div role="cell" className={`${selectionCell} surface-file-row-selection`}>
            {selection}
            {cut ? <span className="sr-only">{t('files.explorer.cutMark')}</span> : null}
          </div>
          <div role="cell" className={nameCell}>
            <div className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-control [&_img]:size-full [&_img]:object-cover">
              {icon}
            </div>
            <div className="min-w-0 flex-1">
              {title}
              {tags}
              {expiry}
              <p className="mt-1 text-xs text-ink-muted @xl/file-list:hidden">
                {entry.kind === 'file' ? formatFileBytes(entry.sizeBytes) : kind}
              </p>
            </div>
          </div>
          {columns.map((column) => (
            <div
              role="cell"
              key={column}
              className={`${metadataCell} truncate text-xs text-ink-muted`}
              title={columnValue(column)}
            >
              {columnValue(column)}
            </div>
          ))}
          <div role="cell" className={actionsCell}>
            {actions}
          </div>
        </>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="flex size-6 shrink-0 items-center justify-center overflow-hidden">
              {glyph}
            </div>
            <div className="min-w-0 flex-1">{title}</div>
          </div>
          {thumbnail && !annotation?.emoji ? (
            <div
              data-file-thumbnail
              className="flex min-w-0 justify-center rounded-control bg-surface-muted/60 p-1 [&_img]:max-h-24 [&_img]:w-full [&_img]:object-contain"
            >
              {thumbnail}
            </div>
          ) : null}
          {tags}
          {expiry}
          <div className="flex min-w-0 items-center gap-1">
            <div className={selectionCell}>{selection}</div>
            <p
              className="min-w-0 flex-1 truncate text-xs text-ink-muted"
              title={time.full(entry.trashedAt ?? entry.updatedAt)}
            >
              {entry.kind === 'file' ? formatFileBytes(entry.sizeBytes) : kind} ·{' '}
              {time.date(entry.trashedAt ?? entry.updatedAt)}
            </p>
            {cut ? <span className="sr-only">{t('files.explorer.cutMark')}</span> : null}
            <div className={actionsCell}>{actions}</div>
          </div>
        </>
      )}
    </article>
  );
}
