'use client';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Toolbar } from '@clouddrive/surface-foundation/layout';
import { BreadcrumbTrail } from '@clouddrive/ui-adapter/navigation';
import { IconAction } from '@clouddrive/ui-adapter/icon-action';
import { Action } from '@clouddrive/ui-adapter/action';
import { CheckboxField, TextField } from '@clouddrive/ui-adapter/form-field';
import { useContainerBreakpoint } from '@clouddrive/ui-adapter/container-layout';
import { MenuButton } from '@clouddrive/ui-adapter/menu-button';
import { DialogSurface, DrawerSurface } from '@clouddrive/ui-adapter/overlays';
import { StateSurface } from '@clouddrive/ui-adapter/state-surface';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { FileAnnotationSummary } from '../../../src/files/annotation-values';
import { fileIconExtension, type FileIconRule } from '../../../src/files/icon-rules';
import { isMarkdownFile } from '../../../src/files/markdown';
import { fileClipboardMaxEntries, type FileClipboardMode } from '../../../src/files/clipboard';
import { formatFileBytes as bytes } from '../../../src/files/format';
import {
  Archive,
  ArrowUp,
  ArrowUpDown,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileGlyph,
  FolderInput,
  History,
  Home,
  Info,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Settings,
  Share2,
  Shield,
  SlidersHorizontal,
  Tag,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from '../../../src/files/icons';
import {
  FilesError,
  type FileEntry,
  type FileListing,
  type FileQuery,
  type FileViewPreferences,
  type UploadCandidate,
} from '../../../src/files/model';
import {
  changeFileView,
  resolveFileView,
  type FilePreferenceSnapshot,
} from '../../../src/files/preferences';
import type { PinTarget } from '../../../src/files/navigation';
import { FileMedia, useFiles, useTransfers, useTransferSnapshot } from '../../../src/files/runtime';
import { decodeFileFilters, encodeFileFilters, type FileFilters } from '../../../src/files/search';
import { fileSelectionRange, nextFileFocus } from '../../../src/files/selection';
import {
  defaultFileViewPreferences,
  fileViewPreferencesSchema,
} from '../../../src/files/view-options';
import { useWorkspaceCreate, useWorkspaceRevision } from '../stores/workspace';
import { ActiveFilterChips } from './active-filter-chips';
import { AdvancedSearchDialog } from './advanced-search-dialog';
import { AnnotationPanel } from './annotation-panel';
import { FileItem, FileListHeader, type FileSelectionGesture } from './file-item';
import { CursorFilePagination, NumberedFilePagination } from './file-pagination';
import { PinDialog } from './pinned-links';
import { ShareDialog } from './share-dialog';
import { directLinkBatchLimit } from '../../../src/files/direct-links';
import { SaveShortcutDialog, ShortcutActionDialog } from './shortcut-dialogs';
import { TagsBatchDialog } from './tags-batch-dialog';
import { TagBadges } from './tag-badges';
import { useFileTime } from './use-file-time';
import { VersionsPanel } from './versions-panel';
import { ViewOptionsDialog } from './view-options-dialog';
import { useCursorFileFeed } from './use-cursor-file-feed';
import { useFileReader } from './use-file-reader';
import { useReaderWorkspace } from './reader-workspace-context';
import { FileApplicationSelection } from './file-reader';
import { archiveFile } from './file-reader-session';
import type { TrashPurgeSelection } from '../../../src/files/trash-purge';

const TrashPurgeDialog = lazy(() => import('./trash-purge-dialog'));
const ArchiveCreateDialog = lazy(() =>
  import('./archive-create-dialog').then((module) => ({ default: module.ArchiveCreateDialog })),
);
const DirectLinksDialog = lazy(() => import('./direct-links-dialog'));
const HistorySettingsDialog = lazy(() =>
  import('./history-preferences-dialog').then((module) => ({
    default: module.HistoryPreferencesDialog,
  })),
);
type Props = Readonly<{
  parent: string;
  category: string;
  trash: boolean;
  search: string;
  filters: FileFilters;
  page: number;
  numbered: boolean;
  cursor: string;
  queryInvalid: boolean;
  navigate: (query: Record<string, string>) => void;
}>;
type Dialog = {
  mode: 'rename' | 'move' | 'copy' | 'remove' | 'restore';
  targets: FileEntry[];
};
const FileAccessDialog = lazy(() =>
  import('./access-dialog').then((module) => ({ default: module.FileAccessDialog })),
);

export function FilesPage({
  parent,
  category,
  trash,
  search,
  filters,
  page,
  numbered,
  cursor,
  queryInvalid,
  navigate: routeNavigate,
}: Props) {
  const filterKey = encodeFileFilters(filters);
  const port = useFiles();
  const transfers = useTransfers();
  const transferState = useTransferSnapshot();
  const { t, locale } = useFrontendTranslation();
  const chinese = locale.startsWith('zh');
  const openWithLabel = chinese ? '打开方式' : 'Open with';
  const [listingSnapshot, setListingSnapshot] = useState<{
    query: FileQuery;
    revision: number;
    value: FileListing;
  }>();
  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useWorkspaceRevision();
  const [iconRules, setIconRules] = useState<readonly FileIconRule[]>([]);
  const [iconRulesUnavailable, setIconRulesUnavailable] = useState(false);
  const createInWorkspace = useWorkspaceCreate();
  const [saveShortcut, setSaveShortcut] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<FileEntry>();
  const [trashSelection, setTrashSelection] = useState<TrashPurgeSelection>();
  const [pinTarget, setPinTarget] = useState<PinTarget>();
  const [preferences, setPreferences] = useState(() =>
    fileViewPreferencesSchema.parse(defaultFileViewPreferences),
  );
  const preferenceParent = !category && !trash && !search && !filterKey ? parent : undefined;
  const preferenceScope = preferenceParent === undefined ? 'global' : 'folder:' + preferenceParent;
  const preferenceScopeRef = useRef(preferenceScope);
  preferenceScopeRef.current = preferenceScope;
  const [preferenceSnapshot, setPreferenceSnapshot] = useState<FilePreferenceSnapshot>(),
    [preferenceFailure, setPreferenceFailure] = useState(''),
    [preferenceBusy, setPreferenceBusy] = useState(false),
    [preferenceReload, setPreferenceReload] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false),
    [viewOptionsOpen, setViewOptionsOpen] = useState(false),
    [inspectorOpen, setInspectorOpen] = useState(false),
    [historySettingsOpen, setHistorySettingsOpen] = useState(false);

  const { ref: measureCollection, matches: inspectorDocked } = useContainerBreakpoint('4xl');
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const compactActions = useRef<HTMLDivElement>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!inspectorOpen || !inspectorDocked) return;
    const frame = requestAnimationFrame(() =>
      inspectorHeading.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [inspectorOpen, inspectorDocked]);
  const time = useFileTime();
  const [focusedEntry, setFocusedEntry] = useState(''),
    [selectionAnchor, setSelectionAnchor] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog>();
  const [shareTarget, setShareTarget] = useState<FileEntry>();
  const [directTargets, setDirectTargets] = useState<readonly FileEntry[]>();
  const [accessTarget, setAccessTarget] = useState<FileEntry>();
  const [zipSelection, setZIPSelection] = useState<{
    entries: readonly FileEntry[];
    parent: string;
  }>();
  const [queuedZIPName, setQueuedZIPName] = useState('');
  const [contextEntry, setContextEntry] = useState<string>();
  const [galleryPage, setGalleryPage] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const destinationDialogOpen =
    dialog?.mode === 'move' || dialog?.mode === 'restore' || dialog?.mode === 'copy';
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [folders, setFolders] = useState<FileListing>();
  const [dialogFailure, setDialogFailure] = useState('');
  const [detail, setDetail] = useState<FileEntry>();
  const [versionEntry, setVersionEntry] = useState<FileEntry>();
  const [tagsBatch, setTagsBatch] = useState<{
    mode: 'add' | 'remove';
    targets: FileAnnotationSummary[];
  }>();
  const [galleryAnnotations, setGalleryAnnotations] = useState<FileAnnotationSummary[]>([]),
    [galleryAnnotationsLoading, setGalleryAnnotationsLoading] = useState(false),
    [galleryAnnotationFailure, setGalleryAnnotationFailure] = useState('');
  const fileContent = useRef<HTMLElement>(null);
  const errorText = useCallback(
    (error: unknown) =>
      t(`files.errors.${error instanceof FilesError ? error.code : 'unavailable'}`),
    [t],
  );
  const reload = useCallback(() => setRevision((value) => value + 1), [setRevision]);
  const firstPage = () =>
    navigate({ parent, category, trash: trash ? 'true' : '', search, filter: filterKey });
  const preferenceReady = !!preferenceSnapshot || !!preferenceFailure;
  const cursorWaitingForPreferences = !!cursor && !preferenceReady;
  const listQuery = useMemo<FileQuery>(
    () => ({
      parent,
      category,
      trash,
      search,
      sort: preferences.sort,
      desc: preferences.desc,
      filters: decodeFileFilters(filterKey),
      foldersFirst: preferences.foldersFirst,
      page: preferences.view === 'gallery' ? 1 : page,
      pageSize: preferences.view === 'gallery' ? 0 : preferences.pageSize,
      ...(preferences.view !== 'gallery'
        ? { pagination: numbered ? ('numbered' as const) : ('auto' as const), cursor }
        : {}),
    }),
    [
      parent,
      category,
      trash,
      search,
      preferences.sort,
      preferences.desc,
      filterKey,
      preferences.foldersFirst,
      preferences.view,
      preferences.pageSize,
      page,
      numbered,
      cursor,
    ],
  );
  const firstListing =
    listingSnapshot?.query === listQuery && listingSnapshot.revision === revision
      ? listingSnapshot.value
      : undefined;
  const feed = useCursorFileFeed(
    !loading && !navigating && !queryInvalid && preferenceReady ? firstListing : undefined,
    listQuery,
    port.list,
  );
  const listing = feed.listing ?? firstListing;
  const { restoreListPosition } = useReaderWorkspace();
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const content = document.getElementById('main-content');
      if (content) restoreListPosition(content, Boolean(listing) && !loading);
    });
    return () => cancelAnimationFrame(frame);
  }, [listing, loading, restoreListPosition]);
  const iconsByExtension = useMemo(() => {
    const lookup = new Map<string, FileIconRule>();
    for (const rule of iconRules)
      for (const extension of rule.extensions) lookup.set(extension, rule);
    return lookup;
  }, [iconRules]);
  useEffect(() => {
    const controller = new AbortController();
    void port.readActiveFileIcons(controller.signal).then(
      (rules) => {
        if (controller.signal.aborted) return;
        setIconRules(rules);
        setIconRulesUnavailable(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setIconRules([]);
        setIconRulesUnavailable(true);
      },
    );
    return () => controller.abort();
  }, [port, revision]);

  function goToNumberedPage(nextPage: number) {
    fileContent.current?.scrollIntoView({ block: 'start' });
    fileContent.current?.focus({ preventScroll: true });
    navigate({
      parent,
      category,
      trash: trash ? 'true' : '',
      search,
      filter: filterKey,
      page: String(nextPage),
    });
  }
  function restartCursor() {
    fileContent.current?.scrollIntoView({ block: 'start' });
    if (cursor) firstPage();
    else reload();
  }

  useEffect(() => {
    const controller = new AbortController();
    setPreferenceSnapshot(undefined);
    setPreferenceFailure('');
    void port
      .loadPreferences(controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setPreferenceSnapshot(snapshot);
          setPreferences(resolveFileView(snapshot.configuration, preferenceParent));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setPreferenceFailure(t('files.preferences.failure', { reason: errorText(error) }));
      });
    return () => controller.abort();
  }, [port, t, errorText, preferenceParent, preferenceReload]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure('');
    setSelected([]);
    setSelectionAnchor('');
    setFocusedEntry('');
    if (queryInvalid) {
      setListingSnapshot(undefined);
      setFailure(t('files.discovery.invalidLink'));
      setLoading(false);
      setNavigating(false);
      return () => controller.abort();
    }
    if (cursorWaitingForPreferences) return () => controller.abort();
    port
      .list(listQuery, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setListingSnapshot({ query: listQuery, revision, value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setListingSnapshot(undefined);
          setFailure(
            cursor && error instanceof FilesError && ['invalid', 'conflict'].includes(error.code)
              ? chinese
                ? '此翻页位置已失效，请从第一页重新浏览。'
                : 'This page position has expired. Start again from the first page.'
              : error instanceof FilesError && error.code === 'large'
                ? t('files.discovery.budgetExceeded')
                : errorText(error),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setNavigating(false);
        }
      });
    return () => controller.abort();
  }, [
    port,
    listQuery,
    cursor,
    cursorWaitingForPreferences,
    queryInvalid,
    revision,
    errorText,
    chinese,
    t,
  ]);
  useEffect(() => {
    if (!destinationDialogOpen) return;
    const controller = new AbortController();
    setFolders(undefined);
    port
      .list(
        { parent: destination, category: '', search: '', trash: false, sort: 'name', desc: false },
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted) setFolders(value);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setDialogFailure(errorText(error));
      });
    return () => controller.abort();
  }, [port, destinationDialogOpen, destination, errorText]);

  const clipboard = useSyncExternalStore(
    port.clipboard.subscribe,
    port.clipboard.getSnapshot,
    port.clipboard.getSnapshot,
  );
  const [pasteFailures, setPasteFailures] = useState<readonly { name: string; reason: string }[]>(
    [],
  );
  const pasteAllowed =
    !trash && !category && !search && !filterKey && !loading && !navigating && !!listing;
  const queueClipboard = useCallback(
    (mode: FileClipboardMode, entries: FileEntry[]) => {
      try {
        port.clipboard.set(mode, entries);
        setPasteFailures([]);
      } catch (error) {
        setNotice(
          error instanceof FilesError && ['invalid', 'large'].includes(error.code)
            ? t('files.explorer.limit', { count: fileClipboardMaxEntries })
            : errorText(error),
        );
      }
    },
    [port, t, errorText],
  );
  const pasteClipboard = useCallback(async () => {
    if (!pasteAllowed || clipboard.pending || !clipboard.entries.length) return;
    setPasteFailures([]);
    setNotice('');
    try {
      const result = await port.clipboard.paste(parent);
      setNotice(t('files.explorer.pasteDone', { count: result.completed }));
      setPasteFailures(
        result.failures.map((item) => ({ name: item.entry.name, reason: errorText(item.error) })),
      );
      reload();
    } catch (error) {
      setNotice(errorText(error));
      reload();
    }
  }, [
    port,
    parent,
    pasteAllowed,
    clipboard.pending,
    clipboard.entries.length,
    t,
    errorText,
    reload,
  ]);
  const enqueue = useCallback(
    (candidates: readonly UploadCandidate[]) => {
      if (trash || !listing) {
        for (const candidate of candidates) port.releaseCandidate(candidate.id);
        return;
      }
      void transfers.enqueue(candidates, parent).catch((error) => setNotice(errorText(error)));
    },
    [trash, listing, parent, port, transfers, errorText],
  );
  useEffect(() => port.subscribeDrop(enqueue), [port, enqueue]);
  const completedRevision = useRef(transferState.completedRevision);
  useEffect(() => {
    if (completedRevision.current !== transferState.completedRevision) {
      completedRevision.current = transferState.completedRevision;
      reload();
    }
  }, [transferState.completedRevision, reload]);

  async function persistPreferences(input: FilePreferenceSnapshot): Promise<boolean> {
    if (preferenceBusy || !preferenceSnapshot) return false;
    const scope = preferenceScope;
    setPreferenceBusy(true);
    setPreferenceFailure('');
    try {
      const snapshot = await port.savePreferences(input);
      if (preferenceScopeRef.current !== scope) return true;
      setPreferenceSnapshot(snapshot);
      applyPreferences(resolveFileView(snapshot.configuration, preferenceParent));
      setNotice(t('files.preferences.saved'));
      return true;
    } catch (error) {
      if (preferenceScopeRef.current === scope)
        setPreferenceFailure(t('files.preferences.failure', { reason: errorText(error) }));
      return false;
    } finally {
      setPreferenceBusy(false);
    }
  }
  function savePreferences(next: FileViewPreferences) {
    if (!preferenceSnapshot || preferenceBusy) return;
    try {
      void persistPreferences({
        ...preferenceSnapshot,
        configuration: changeFileView(preferenceSnapshot.configuration, next, preferenceParent),
      });
    } catch (error) {
      setPreferenceFailure(t('files.preferences.failure', { reason: errorText(error) }));
    }
  }
  function applyPreferences(next: FileViewPreferences) {
    const affectsQuery =
      next.sort !== preferences.sort ||
      next.desc !== preferences.desc ||
      next.foldersFirst !== preferences.foldersFirst ||
      next.pageSize !== preferences.pageSize ||
      next.view !== preferences.view;
    setPreferences(fileViewPreferencesSchema.parse(next));
    if (affectsQuery && (page !== 1 || cursor)) firstPage();
  }
  const openDialog = useCallback(
    (mode: Dialog['mode'] | 'folder', targets: FileEntry[] = []) => {
      if (mode === 'folder') {
        createInWorkspace('folder');
        return;
      }
      setNotice('');
      setDialogFailure('');
      const source = targets[0];
      const dot = source?.kind === 'file' ? source.name.lastIndexOf('.') : -1;
      const copyName = source
        ? `${t('files.copyName', { name: dot > 0 ? source.name.slice(0, dot) : source.name })}${dot > 0 ? source.name.slice(dot) : ''}`
        : '';
      setName(mode === 'rename' ? (source?.name ?? '') : mode === 'copy' ? copyName : '');
      setDestination('');
      setDialog({ mode, targets });
    },
    [t, createInWorkspace],
  );
  async function confirmDialog() {
    if (!dialog) return;
    setDialogFailure('');
    try {
      {
        const failures: FileEntry[] = [];
        let lastError: unknown;
        for (const entry of dialog.targets) {
          try {
            if (dialog.mode === 'rename')
              await port.update(entry.id, {
                name,
                ...(entry.kind === 'shortcut' ? { expectedRevision: entry.contentRevision } : {}),
              });
            else if (dialog.mode === 'copy') await port.copy(entry.id, destination, name);
            else if (dialog.mode === 'move')
              await port.update(entry.id, {
                parentId: destination,
                ...(entry.kind === 'shortcut' ? { expectedRevision: entry.contentRevision } : {}),
              });
            else if (dialog.mode === 'remove') await port.trash(entry.id);
            else await port.restore(entry.id, destination);
          } catch (error) {
            failures.push(entry);
            lastError = error;
          }
        }
        if (failures.length) {
          setDialog({ ...dialog, targets: failures });
          setDialogFailure(
            `${t('files.operationPartial', { count: failures.length })} ${errorText(lastError)}`,
          );
          reload();
          throw lastError;
        }
      }
      setNotice(t('files.operationDone'));
      reload();
    } catch (error) {
      setDialogFailure((current) => current || errorText(error));
      throw error;
    }
  }
  async function uploadVersion(entry: FileEntry) {
    try {
      const candidates = await port.chooseFiles();
      if (!candidates.length) return;
      if (candidates.length !== 1) {
        for (const candidate of candidates) port.releaseCandidate(candidate.id);
        setNotice(t('files.versions.singleFile'));
        return;
      }
      const candidate = candidates[0];
      if (candidate) await transfers.replace(candidate, entry);
    } catch (error) {
      setNotice(errorText(error));
    }
  }
  function showDetails(entry: FileEntry) {
    setDetail(entry);
  }
  const maxMediaBytes = listing?.maxMediaBytes;
  const pageCount = listing
    ? Math.max(1, Math.ceil(listing.items.length / listing.maxGalleryEntries))
    : 0;
  const currentGalleryPage = Math.min(galleryPage, Math.max(0, pageCount - 1));
  const visibleItems = useMemo(
    () =>
      listing
        ? preferences.view === 'gallery'
          ? listing.items.slice(
              currentGalleryPage * listing.maxGalleryEntries,
              (currentGalleryPage + 1) * listing.maxGalleryEntries,
            )
          : listing.items
        : [],
    [listing, preferences.view, currentGalleryPage],
  );
  const reader = useFileReader({
    scope: JSON.stringify([parent, category, trash, search, filterKey, page, numbered, cursor]),
    entries: visibleItems,
    maxMediaBytes,
    maxTextBytes: listing?.maxTextBytes,
    pdfReaderLimits: listing?.pdfReader,
    onNotice: setNotice,
  });
  const cancelPendingOpen = reader.cancelPending;
  const navigate = useCallback(
    (query: Record<string, string>) => {
      if (
        (query.parent ?? '') !== parent ||
        (query.category ?? '') !== category ||
        (query.trash === 'true') !== trash ||
        (query.search ?? '') !== search ||
        (query.filter ?? '') !== filterKey ||
        Number(query.page ?? 1) !== page ||
        !!query.page !== numbered ||
        (query.cursor ?? '') !== cursor
      ) {
        cancelPendingOpen();
        setNavigating(true);
      }
      routeNavigate(query);
    },
    [
      routeNavigate,
      parent,
      category,
      trash,
      search,
      filterKey,
      page,
      numbered,
      cursor,
      cancelPendingOpen,
    ],
  );
  const showPreview = reader.open;
  const download = reader.download;
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const targets = useMemo(
    () => listing?.items.filter((entry) => selectedIds.has(entry.id)) ?? [],
    [listing, selectedIds],
  );
  useEffect(
    () => setGalleryPage(0),
    [parent, category, trash, search, filterKey, preferences.view],
  );
  const visibleIds = useMemo(() => visibleItems.map((entry) => entry.id), [visibleItems]);
  useEffect(() => {
    const controller = new AbortController();
    setGalleryAnnotations([]);
    setGalleryAnnotationFailure('');
    if (preferences.view !== 'gallery' || !visibleIds.length) {
      setGalleryAnnotationsLoading(false);
      return () => controller.abort();
    }
    setGalleryAnnotationsLoading(true);
    void port.annotations
      .summaries(visibleIds, trash ? 'trash' : 'active', controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setGalleryAnnotations(value.items);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setGalleryAnnotationFailure(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setGalleryAnnotationsLoading(false);
      });
    return () => controller.abort();
  }, [port, preferences.view, trash, visibleIds, revision, errorText]);
  const annotationMap = useMemo(
    () =>
      new Map(
        (preferences.view === 'gallery'
          ? galleryAnnotations
          : (listing?.annotationSummaries ?? [])
        ).map((value) => [value.entryId, value]),
      ),
    [preferences.view, galleryAnnotations, listing],
  );
  function openTagsBatch(mode: 'add' | 'remove') {
    if (!listing || !targets.length) return;
    if (targets.length > listing.annotationLimits.maxBatchEntries) {
      setNotice(
        t('files.annotations.batchLimit', { count: listing.annotationLimits.maxBatchEntries }),
      );
      return;
    }
    const summaries: FileAnnotationSummary[] = [];
    for (const entry of targets) {
      const summary = annotationMap.get(entry.id);
      if (!summary) {
        setNotice(t('files.errors.unavailable'));
        return;
      }
      summaries.push(summary);
    }
    setTagsBatch({ mode, targets: summaries });
  }
  const thumbnailIds = useMemo(
    () =>
      new Set(
        visibleItems
          .filter(
            (entry) =>
              entry.kind === 'file' &&
              !annotationMap.get(entry.id)?.emoji &&
              entry.mediaType.startsWith('image/') &&
              listing &&
              entry.sizeBytes <= listing.maxThumbnailBytes,
          )
          .slice(0, listing?.maxGalleryEntries ?? 0)
          .map((entry) => entry.id),
      ),
    [visibleItems, listing, annotationMap],
  );
  function selectEntry(id: string, gesture: FileSelectionGesture) {
    if (gesture.extend) {
      const range = fileSelectionRange(visibleIds, selectionAnchor || focusedEntry || id, id);
      setSelected((current) =>
        gesture.toggle ? [...new Set([...current, ...range])] : [...range],
      );
    } else {
      setSelectionAnchor(id);
      setSelected((current) =>
        gesture.toggle
          ? current.includes(id)
            ? current.filter((value) => value !== id)
            : [...current, id]
          : [id],
      );
    }
    setFocusedEntry(id);
  }
  useEffect(
    () =>
      port.subscribeShortcuts((shortcut) => {
        const chosen = targets;
        if (
          shortcut === 'next' ||
          shortcut === 'previous' ||
          shortcut === 'first' ||
          shortcut === 'last' ||
          shortcut === 'extendNext' ||
          shortcut === 'extendPrevious' ||
          shortcut === 'extendFirst' ||
          shortcut === 'extendLast'
        ) {
          const direction =
            shortcut === 'extendNext'
              ? 'next'
              : shortcut === 'extendPrevious'
                ? 'previous'
                : shortcut === 'extendFirst'
                  ? 'first'
                  : shortcut === 'extendLast'
                    ? 'last'
                    : shortcut;
          const ids = visibleIds,
            next = nextFileFocus(ids, focusedEntry, direction);
          if (next) {
            if (shortcut.startsWith('extend')) {
              const range = fileSelectionRange(ids, selectionAnchor || focusedEntry || next, next);
              if (!selectionAnchor) setSelectionAnchor(focusedEntry || next);
              setSelected([...range]);
            }
            setFocusedEntry(next);
            port.focusEntry(next);
          }
          return;
        }
        if (shortcut === 'copySelection' || shortcut === 'cutSelection') {
          if (!trash && !loading && !navigating && chosen.length)
            queueClipboard(shortcut === 'copySelection' ? 'copy' : 'cut', chosen);
        } else if (shortcut === 'pasteSelection') void pasteClipboard();
        else if (shortcut === 'parentFolder') {
          if (parent && !trash && !category && !loading && !navigating)
            navigate({ parent: listing?.breadcrumbs.at(-2)?.id ?? '' });
        } else if (shortcut === 'search') port.focusSearch();
        else if (shortcut === 'refresh') reload();
        else if (shortcut === 'selectAll') setSelected([...visibleIds]);
        else if (shortcut === 'clearSelection') setSelected([]);
        else if (shortcut === 'newFolder' && !trash && listing) openDialog('folder');
        else if (shortcut === 'rename' && !trash && chosen.length === 1)
          openDialog('rename', chosen);
        else if (shortcut === 'trash' && !trash && chosen.length) openDialog('remove', chosen);
        else if ((shortcut === 'open' && chosen.length === 1) || shortcut === 'openFocused') {
          const entry =
            shortcut === 'openFocused'
              ? listing?.items.find((item) => item.id === focusedEntry)
              : chosen[0];
          if (!entry) return;
          if (trash) openDialog('restore', [entry]);
          else if (entry.kind === 'folder') navigate({ parent: entry.id });
          else void showPreview(entry);
        }
      }),
    [
      port,
      listing,
      targets,
      trash,
      navigate,
      openDialog,
      showPreview,
      reload,
      visibleIds,
      focusedEntry,
      selectionAnchor,
      queueClipboard,
      pasteClipboard,
      parent,
      category,
      loading,
      navigating,
    ],
  );
  const title = trash
    ? t('files.trash')
    : category
      ? t(`files.${category}`)
      : (listing?.breadcrumbs.at(-1)?.name ?? t('files.nav'));
  const inspectedEntry =
    targets.length === 1
      ? targets[0]
      : focusedEntry
        ? listing?.items.find((item) => item.id === focusedEntry)
        : undefined;
  const selectedTotalBytes = targets.reduce(
    (sum, entry) => sum + (entry.kind === 'file' ? entry.sizeBytes : 0),
    0,
  );
  const folderActions = [
    { id: 'pin-folder', label: t('files.navigation.pin'), icon: <Pin className="size-4" /> },
    { id: 'save-shortcut', label: t('files.navigation.save'), icon: <Link2 className="size-4" /> },
    { id: 'copy-path', label: t('files.explorer.copyPath'), icon: <Copy className="size-4" /> },
    {
      id: 'version-retention',
      label: t('files.retention.title'),
      icon: <Settings className="size-4" />,
    },
    {
      id: 'select-all',
      label: t('files.selectAll'),
      disabled: loading || navigating || !visibleIds.length,
    },
    { id: 'select-none', label: t('files.explorer.none'), disabled: !selected.length },
    {
      id: 'select-invert',
      label: t('files.explorer.invert'),
      disabled: loading || navigating || !visibleIds.length,
    },
  ];
  const sortGroups = [
    {
      id: 'field',
      label: t('files.explorer.sortField'),
      items: (['name', 'size', 'updated', 'created'] as const).map((sort) => ({
        id: sort,
        label: t('files.' + sort + 'Sort'),
        selected: preferences.sort === sort,
        disabled: preferenceBusy || !preferenceSnapshot,
      })),
    },
    {
      id: 'order',
      label: t('files.explorer.sortOrder'),
      items: [
        {
          id: 'asc',
          label: t('files.explorer.ascending'),
          selected: !preferences.desc,
          disabled: preferenceBusy || !preferenceSnapshot,
        },
        {
          id: 'desc',
          label: t('files.explorer.descending'),
          selected: preferences.desc,
          disabled: preferenceBusy || !preferenceSnapshot,
        },
      ],
    },
  ];
  function runFolderAction(action: string) {
    if (action === 'version-retention') setHistorySettingsOpen(true);
    else if (action === 'copy-path')
      void port.annotations
        .copyText('/' + (listing?.breadcrumbs.map((entry) => entry.name).join('/') ?? ''))
        .then(() => setNotice(t('files.explorer.pathCopied')))
        .catch((error) => setNotice(errorText(error)));
    else if (action === 'select-all') setSelected([...visibleIds]);
    else if (action === 'select-none') setSelected([]);
    else if (action === 'select-invert')
      setSelected(visibleIds.filter((id) => !selectedIds.has(id)));
    else if (action === 'save-shortcut') setSaveShortcut(true);
    else if (action === 'pin-folder') setPinTarget({ targetKind: 'folder', targetId: parent });
  }

  function changeSort(sort: string) {
    void savePreferences({
      ...preferences,
      ...(sort === 'asc' || sort === 'desc'
        ? { desc: sort === 'desc' }
        : { sort: sort as FileViewPreferences['sort'] }),
    });
  }

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    requestAnimationFrame(() => {
      const trigger = inspectorTrigger.current?.getClientRects().length
        ? inspectorTrigger.current
        : compactActions.current?.querySelector('button');
      trigger?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    const element = inspectorHeading.current?.closest('.surface-file-collection');
    if (!element || !inspectorOpen || !inspectorDocked) return;
    function escape(event: Event) {
      if (event instanceof KeyboardEvent && event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closeInspector();
      }
    }
    element.addEventListener('keydown', escape);
    return () => element.removeEventListener('keydown', escape);
  }, [closeInspector, inspectorDocked, inspectorOpen]);

  function toggleInspector() {
    if (inspectorOpen) closeInspector();
    else setInspectorOpen(true);
  }

  function runInspectorAction(action: () => void) {
    if (!inspectorDocked) setInspectorOpen(false);
    action();
  }

  function runCompactAction(action: string) {
    if (action === 'refresh') reload();
    else if (action === 'advanced') setAdvancedOpen(true);
    else if (action === 'inspector') toggleInspector();
    else if (folderActions.some(({ id }) => id === action)) runFolderAction(action);
    else changeSort(action);
  }
  const inspectorContent =
    targets.length > 1 ? (
      <div className="space-y-3 pt-4 text-sm text-ink-muted">
        <p className="font-medium text-ink">
          {t('files.explorer.inspectorMulti', {
            count: targets.length,
            size: bytes(selectedTotalBytes),
          })}
        </p>
      </div>
    ) : inspectedEntry ? (
      <div className="space-y-4 pt-4">
        <div className="flex h-36 w-full items-center justify-center overflow-hidden rounded-control border border-border/60 bg-surface-muted/60 [&_img]:max-h-full [&_img]:max-w-full [&_img]:object-contain [&_img]:p-2">
          {preferences.thumbnails &&
          thumbnailIds.has(inspectedEntry.id) &&
          listing &&
          inspectedEntry.sizeBytes <= listing.maxThumbnailBytes ? (
            <FileMedia
              key={inspectedEntry.id + ':' + inspectedEntry.contentRevision}
              entry={inspectedEntry}
              mode="thumbnail"
              maxBytes={listing.maxThumbnailBytes}
            />
          ) : (
            <FileGlyph
              kind={inspectedEntry.kind}
              mediaType={inspectedEntry.mediaType}
              size="large"
              emoji={annotationMap.get(inspectedEntry.id)?.emoji}
              color={annotationMap.get(inspectedEntry.id)?.folderColor}
              rule={
                inspectedEntry.kind === 'file'
                  ? iconsByExtension.get(fileIconExtension(inspectedEntry.name))
                  : undefined
              }
            />
          )}
        </div>
        <div className="space-y-1">
          <p className="break-words text-sm font-semibold text-ink">{inspectedEntry.name}</p>
          {annotationMap.get(inspectedEntry.id) ? (
            <TagBadges
              tags={annotationMap.get(inspectedEntry.id)!.tags}
              onTag={(tagName) =>
                navigate({
                  filter: encodeFileFilters({
                    scope: 'all',
                    tagFilter: { names: [tagName], match: 'all' },
                  }),
                })
              }
            />
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <div>
            <dt className="text-ink-muted">{t('files.explorer.inspectorMetaType')}</dt>
            <dd className="mt-0.5 truncate font-medium text-ink">
              {inspectedEntry.kind === 'file'
                ? inspectedEntry.mediaType || t('files.discovery.file')
                : inspectedEntry.kind === 'folder'
                  ? t('files.folder')
                  : t('files.navigation.shortcut')}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t('files.explorer.inspectorMetaSize')}</dt>
            <dd className="mt-0.5 font-medium text-ink">
              {inspectedEntry.kind === 'file' ? bytes(inspectedEntry.sizeBytes) : '—'}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-ink-muted">{t('files.explorer.inspectorMetaUpdated')}</dt>
            <dd className="mt-0.5 font-medium text-ink">{time.full(inspectedEntry.updatedAt)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-ink-muted">{t('files.explorer.inspectorMetaCreated')}</dt>
            <dd className="mt-0.5 font-medium text-ink">{time.full(inspectedEntry.createdAt)}</dd>
          </div>
        </dl>
        {!trash ? (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Action
              size="sm"
              variant="secondary"
              leadingIcon={<Eye className="size-4" />}
              onPress={() =>
                runInspectorAction(() => {
                  if (inspectedEntry.kind === 'folder') navigate({ parent: inspectedEntry.id });
                  else void showPreview(inspectedEntry);
                })
              }
            >
              {t('files.explorer.open')}
            </Action>
            {inspectedEntry.kind === 'file' ? (
              <Action
                size="sm"
                variant="secondary"
                leadingIcon={<Download className="size-4" />}
                onPress={() => void download(inspectedEntry)}
              >
                {t('files.download')}
              </Action>
            ) : null}
            {inspectedEntry.kind !== 'shortcut' ? (
              <Action
                size="sm"
                variant="secondary"
                leadingIcon={<Share2 className="size-4" />}
                onPress={() => runInspectorAction(() => setShareTarget(inspectedEntry))}
              >
                {t('files.share')}
              </Action>
            ) : null}
            {inspectedEntry.kind === 'file' ? (
              <Action
                size="sm"
                variant="quiet"
                leadingIcon={<History className="size-4" />}
                onPress={() => runInspectorAction(() => setVersionEntry(inspectedEntry))}
              >
                {t('files.versions.title')}
              </Action>
            ) : null}
            <Action
              size="sm"
              variant="quiet"
              leadingIcon={<Pencil className="size-4" />}
              onPress={() => runInspectorAction(() => showDetails(inspectedEntry))}
            >
              {t('files.explorer.inspectorEditDetails')}
            </Action>
          </div>
        ) : null}
      </div>
    ) : (
      <p className="pt-6 text-center text-xs leading-5 text-ink-muted">
        {t('files.explorer.inspectorEmpty')}
      </p>
    );
  return (
    <>
      <div
        ref={measureCollection}
        className="surface-file-collection flex min-h-full min-w-0 flex-col gap-3"
      >
        <Toolbar
          label={title}
          primary={
            <div className="@container w-full min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[48rem]:flex-nowrap">
                <div
                  data-file-breadcrumbs
                  className="flex min-w-0 basis-full items-center gap-1 @min-[48rem]:flex-1"
                >
                  {parent && !trash && !category ? (
                    <IconAction
                      size="sm"
                      label={t('files.explorer.parent')}
                      tooltip
                      disabled={loading || navigating}
                      onPress={() => navigate({ parent: listing?.breadcrumbs.at(-2)?.id ?? '' })}
                    >
                      <ArrowUp className="size-4" />
                    </IconAction>
                  ) : null}
                  {parent ? (
                    <div className="shrink-0 @min-[48rem]:hidden">
                      <MenuButton
                        ariaLabel={t('files.explorer.ancestors')}
                        triggerVariant="icon"
                        label={<MoreHorizontal className="size-4" />}
                        triggerSize="sm"
                        items={[
                          { id: 'root', label: t('files.nav') },
                          ...(listing?.breadcrumbs.map((entry) => ({
                            id: entry.id,
                            label: entry.name,
                          })) ?? []),
                        ]}
                        onAction={(id) => navigate({ parent: id === 'root' ? '' : id })}
                      />
                    </div>
                  ) : null}
                  <h1 className="sr-only">{title}</h1>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-ink @min-[48rem]:hidden"
                    title={title}
                  >
                    {title}
                  </span>
                  <div className="hidden min-w-0 flex-1 overflow-x-auto @min-[48rem]:block">
                    <BreadcrumbTrail
                      label={t('files.explorer.ancestors')}
                      items={[
                        {
                          id: 'root',
                          label: t('files.nav'),
                          icon: <Home className="size-4" />,
                          href: port.destinationHref('files'),
                          onNavigate: () => navigate({}),
                        },
                        ...(listing?.breadcrumbs.map((entry) => ({
                          id: entry.id,
                          label: entry.name,
                          href: port.destinationHref('files', { parent: entry.id }),
                          onNavigate: () => navigate({ parent: entry.id }),
                        })) ?? []),
                        ...(trash || category ? [{ id: 'scope', label: title }] : []),
                      ]}
                    />
                  </div>
                  {listing ? (
                    <span className="shrink-0 whitespace-nowrap rounded-action bg-surface-muted px-2 py-0.5 text-xs text-ink-muted">
                      {t('files.explorer.itemCount', { count: listing.total })}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {listing?.items.length ? (
                    <CheckboxField
                      label={t('files.discovery.selectPage')}
                      presentation="control-only"
                      checked={selected.length === visibleItems.length}
                      onCheckedChange={(checked) => {
                        setSelectionAnchor('');
                        setSelected(checked ? visibleItems.map((entry) => entry.id) : []);
                      }}
                    />
                  ) : null}
                  <div className="hidden items-center gap-1 @min-[48rem]:flex">
                    <IconAction size="sm" label={t('files.refresh')} tooltip onPress={reload}>
                      <RefreshCw className="size-4" />
                    </IconAction>
                    <MenuButton
                      label={<MoreHorizontal className="size-4" />}
                      ariaLabel={t('files.discovery.folderActions')}
                      triggerVariant="icon"
                      triggerSize="sm"
                      items={folderActions}
                      onAction={runFolderAction}
                    />
                    <IconAction
                      size="sm"
                      label={t('files.discovery.advanced')}
                      tooltip
                      disabled={loading || navigating}
                      onPress={() => setAdvancedOpen(true)}
                    >
                      <SlidersHorizontal className="size-4" />
                    </IconAction>
                  </div>
                  <MenuButton
                    triggerSize="sm"
                    ariaLabel={t('files.explorer.view')}
                    triggerVariant="icon"
                    label={<LayoutGrid className="size-4" />}
                    items={[
                      ...(['grid', 'list', 'gallery'] as const).map((view) => ({
                        id: view,
                        label: t('files.' + view),
                        selected: preferences.view === view,
                      })),
                      {
                        id: 'options',
                        label: t('files.discovery.viewOptions'),
                        icon: <Settings className="size-4" />,
                      },
                    ].map((item) => ({ ...item, disabled: preferenceBusy || !preferenceSnapshot }))}
                    onAction={(view) =>
                      view === 'options'
                        ? setViewOptionsOpen(true)
                        : savePreferences({
                            ...preferences,
                            view: view as FileViewPreferences['view'],
                          })
                    }
                  />
                  <div className="hidden items-center gap-1 @min-[48rem]:flex">
                    <MenuButton
                      triggerSize="sm"
                      ariaLabel={t('files.explorer.sort')}
                      triggerVariant="icon"
                      label={<ArrowUpDown className="size-4" />}
                      groups={sortGroups}
                      onAction={changeSort}
                    />
                    <IconAction
                      size="sm"
                      label={t('files.explorer.inspector')}
                      tooltip
                      ref={inspectorTrigger}
                      expanded={inspectorOpen}
                      onPress={toggleInspector}
                    >
                      <PanelRight className="size-4" />
                    </IconAction>
                  </div>
                  <div ref={compactActions} className="shrink-0 @min-[48rem]:hidden">
                    <MenuButton
                      ariaLabel={t('files.explorer.moreActions')}
                      label={<MoreHorizontal className="size-4" />}
                      triggerVariant="icon"
                      triggerSize="sm"
                      groups={[
                        {
                          id: 'tools',
                          label: t('files.explorer.menuActions'),
                          items: [
                            {
                              id: 'refresh',
                              label: t('files.refresh'),
                              icon: <RefreshCw className="size-4" />,
                            },
                            {
                              id: 'advanced',
                              label: t('files.discovery.advanced'),
                              icon: <SlidersHorizontal className="size-4" />,
                              disabled: loading || navigating,
                            },
                            {
                              id: 'inspector',
                              label: t('files.explorer.inspector'),
                              icon: <PanelRight className="size-4" />,
                            },
                          ],
                        },
                        {
                          id: 'folder',
                          label: t('files.discovery.folderActions'),
                          items: folderActions,
                        },
                        ...sortGroups,
                      ]}
                      onAction={runCompactAction}
                    />
                  </div>
                </div>
              </div>
            </div>
          }
        />
        {listing && !loading && !navigating ? (
          <p role="status" className="sr-only">
            {t('files.explorer.results', {
              count: listing.total,
              scope: trash
                ? t('files.explorer.scopeTrash')
                : filters.scope === 'tree'
                  ? t('files.explorer.scopeTree')
                  : filters.scope === 'all' ||
                      (!filters.scope &&
                        (search ||
                          category ||
                          filters.keywords ||
                          filters.tagFilter ||
                          filters.property))
                    ? t('files.explorer.scopeAll')
                    : t('files.explorer.scopeFolder'),
            })}
          </p>
        ) : null}
        {clipboard.entries.length ? (
          <section
            aria-label={t(
              clipboard.mode === 'cut'
                ? 'files.explorer.clipboardCut'
                : 'files.explorer.clipboardCopy',
              { count: clipboard.entries.length },
            )}
            className="rounded-control border border-brand bg-brand-soft p-3 text-sm"
          >
            <p className="font-semibold">
              {t(
                clipboard.mode === 'cut'
                  ? 'files.explorer.clipboardCut'
                  : 'files.explorer.clipboardCopy',
                { count: clipboard.entries.length },
              )}
            </p>
            <p
              className="truncate text-xs"
              title={clipboard.entries.map((entry) => entry.name).join(', ')}
            >
              {clipboard.entries.map((entry) => entry.name).join(', ')}
            </p>
            <p className="mt-1 text-xs text-ink-muted">{t('files.explorer.clipboardHint')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Action
                size="sm"
                disabled={!pasteAllowed || clipboard.pending}
                loading={clipboard.pending}
                onPress={() => void pasteClipboard()}
              >
                {t('files.explorer.paste')}
              </Action>
              <Action
                size="sm"
                variant="quiet"
                disabled={clipboard.pending}
                onPress={() => {
                  port.clipboard.clear();
                  setPasteFailures([]);
                }}
              >
                {t('files.explorer.clearClipboard')}
              </Action>
            </div>
            {!pasteAllowed ? (
              <p className="mt-1 text-xs">{t('files.explorer.pasteLocation')}</p>
            ) : null}
          </section>
        ) : null}
        {pasteFailures.length ? (
          <ul role="alert" className="rounded-control border border-danger p-3 text-sm text-danger">
            {pasteFailures.map((failure, index) => (
              <li key={index}>{t('files.explorer.pasteFailed', failure)}</li>
            ))}
          </ul>
        ) : null}
        <ActiveFilterChips
          filters={filters}
          onChange={(next) =>
            navigate({
              parent,
              category,
              trash: trash ? 'true' : '',
              search,
              filter: encodeFileFilters(next),
            })
          }
        />
        {cursor && failure && !loading ? (
          <Action variant="secondary" onPress={firstPage}>
            {t('files.discovery.firstPage')}
          </Action>
        ) : queryInvalid ? (
          <Action
            variant="secondary"
            onPress={() => navigate({ parent, category, trash: trash ? 'true' : '' })}
          >
            {t('files.discovery.clear')}
          </Action>
        ) : null}
        {!preferenceSnapshot && !preferenceFailure ? (
          <p role="status" className="text-sm text-ink-muted">
            {t('files.preferences.loading')}
          </p>
        ) : null}
        {preferenceBusy ? (
          <p role="status" className="text-sm text-ink-muted">
            {t('files.preferences.saving')}
          </p>
        ) : null}
        {preferenceFailure ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
            <p>{preferenceFailure}</p>
            <Action
              size="sm"
              variant="quiet"
              disabled={preferenceBusy}
              onPress={() => {
                setViewOptionsOpen(false);
                setPreferenceReload((value) => value + 1);
              }}
            >
              {t('files.preferences.reload')}
            </Action>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-control border border-border bg-surface p-3 text-sm">
            {notice}
          </p>
        ) : null}
        {queuedZIPName ? (
          <div className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface p-3 text-sm">
            <span role="status">
              {t('files.archives.createZIP.queued', { name: queuedZIPName })}
            </span>
            <Action size="sm" variant="quiet" onPress={() => port.navigate('tasks')}>
              {t('files.archives.tasks.open')}
            </Action>
          </div>
        ) : null}
        {galleryAnnotationsLoading ? (
          <p role="status" className="text-sm text-ink-muted">
            {t('files.annotations.loading')}
          </p>
        ) : null}
        {galleryAnnotationFailure ? (
          <p role="alert" className="text-sm text-danger">
            {galleryAnnotationFailure}
          </p>
        ) : null}
        {iconRulesUnavailable ? (
          <p className="text-sm text-ink-muted" role="status">
            {chinese
              ? '文件图标规则暂不可用，当前使用类型图标。'
              : 'File icon rules are unavailable. Showing file type icons.'}
          </p>
        ) : null}
        {listing?.items.length && targets.length ? (
          <div
            role="region"
            aria-label={t('files.explorer.selection')}
            className="surface-bulk-bar flex flex-wrap items-center justify-between gap-2 rounded-panel border border-brand/25 bg-brand-soft/65 px-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              <IconAction
                size="sm"
                label={t('files.explorer.none')}
                tooltip
                onPress={() => setSelected([])}
              >
                <X className="size-4" />
              </IconAction>
              <span className="text-sm font-semibold text-ink">
                {t('files.selected', { count: targets.length })}
              </span>
              {selectedTotalBytes > 0 ? (
                <span className="text-xs text-ink-muted">· {bytes(selectedTotalBytes)}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {trash ? (
                <>
                  <Action
                    variant="secondary"
                    size="sm"
                    leadingIcon={<RotateCcw className="size-4" />}
                    onPress={() => openDialog('restore', targets)}
                  >
                    {t('files.restore')}
                  </Action>
                  <Action
                    variant="danger"
                    size="sm"
                    leadingIcon={<Trash2 className="size-4" />}
                    disabled={loading || navigating}
                    onPress={() =>
                      setTrashSelection({
                        scope: 'selection',
                        ids: targets.map((entry) => entry.id),
                      })
                    }
                  >
                    {t('files.trashPurge.permanent')}
                  </Action>
                </>
              ) : (
                <>
                  {targets.length === 1 && targets[0]?.kind === 'file' ? (
                    <Action
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Download className="size-4" />}
                      onPress={() => {
                        if (targets[0]) void download(targets[0]);
                      }}
                    >
                      {t('files.download')}
                    </Action>
                  ) : (
                    <Action
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Download className="size-4" />}
                      loading={archiving}
                      disabled={archiving || targets.some((entry) => entry.kind === 'shortcut')}
                      onPress={() => {
                        setArchiving(true);
                        setNotice('');
                        void port
                          .archive(selected)
                          .then(() => setNotice(t('files.archiveReady')))
                          .catch((error: unknown) => setNotice(errorText(error)))
                          .finally(() => setArchiving(false));
                      }}
                    >
                      {t('files.archive')}
                    </Action>
                  )}
                  {targets.length === 1 && targets[0]?.kind !== 'shortcut' ? (
                    <Action
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Share2 className="size-4" />}
                      onPress={() => {
                        if (targets[0]) setShareTarget(targets[0]);
                      }}
                    >
                      {t('files.share')}
                    </Action>
                  ) : null}
                  <Action
                    variant="secondary"
                    size="sm"
                    leadingIcon={<FolderInput className="size-4" />}
                    onPress={() => openDialog('move', targets)}
                  >
                    {t('files.move')}
                  </Action>
                  <Action
                    variant="danger"
                    size="sm"
                    leadingIcon={<Trash2 className="size-4" />}
                    onPress={() => openDialog('remove', targets)}
                  >
                    {t('files.remove')}
                  </Action>
                  <MenuButton
                    triggerSize="sm"
                    triggerVariant="standard"
                    ariaLabel={t('files.explorer.moreActions')}
                    label={
                      <span className="flex items-center gap-1">
                        <MoreHorizontal className="size-4" />
                        <span className="hidden sm:inline">{t('files.explorer.moreActions')}</span>
                      </span>
                    }
                    items={[
                      {
                        id: 'copy-clipboard',
                        label: t('files.explorer.copyPending'),
                        icon: <Copy className="size-4" />,
                        disabled: clipboard.pending,
                      },
                      {
                        id: 'cut-clipboard',
                        label: t('files.explorer.cutPending'),
                        icon: <Scissors className="size-4" />,
                        disabled: clipboard.pending,
                      },
                      {
                        id: 'create-zip',
                        label: t('files.archives.createZIP.title'),
                        icon: <Archive className="size-4" />,
                        disabled: targets.some((entry) => entry.kind === 'shortcut'),
                      },
                      ...(targets.every((entry) => entry.kind === 'file')
                        ? [
                            {
                              id: 'direct-links',
                              label: t('files.directLinks.get'),
                              icon: <Link2 className="size-4" />,
                              disabled: targets.length > directLinkBatchLimit,
                            },
                          ]
                        : []),
                      {
                        id: 'batch-add-tags',
                        label: t('files.annotations.batchAdd'),
                        icon: <Tag className="size-4" />,
                        disabled:
                          loading ||
                          navigating ||
                          galleryAnnotationsLoading ||
                          !!galleryAnnotationFailure,
                      },
                      {
                        id: 'batch-remove-tags',
                        label: t('files.annotations.batchRemove'),
                        icon: <Tag className="size-4" />,
                        disabled:
                          loading ||
                          navigating ||
                          galleryAnnotationsLoading ||
                          !!galleryAnnotationFailure,
                      },
                    ]}
                    onAction={(action) => {
                      if (action === 'copy-clipboard') queueClipboard('copy', targets);
                      else if (action === 'cut-clipboard') queueClipboard('cut', targets);
                      else if (action === 'create-zip')
                        setZIPSelection({ entries: targets, parent });
                      else if (action === 'direct-links') setDirectTargets(targets);
                      else if (action === 'batch-add-tags') openTagsBatch('add');
                      else if (action === 'batch-remove-tags') openTagsBatch('remove');
                    }}
                  />
                </>
              )}
            </div>
          </div>
        ) : null}
        <div className="flex min-h-96 min-w-0 flex-1 items-start gap-4">
          <section
            ref={fileContent}
            tabIndex={-1}
            aria-label={title}
            aria-busy={loading || navigating}
            data-file-content
            className={`min-h-96 min-w-0 flex-1 rounded-panel bg-surface p-2 ${!loading && !navigating && !failure && !listing?.items.length ? 'flex flex-col' : ''}`}
          >
            {loading || navigating ? (
              <StateSurface
                state="loading"
                icon={<Cloud />}
                title={t('files.loading')}
                description={t('files.loadingDescription')}
              />
            ) : failure ? (
              <StateSurface
                state="error"
                icon={<Cloud />}
                title={t('files.error')}
                description={failure}
                actionLabel={t('files.retry')}
                onAction={reload}
              />
            ) : !listing?.items.length ? (
              <div data-file-empty className="grid min-h-80 flex-1 place-items-center">
                <StateSurface
                  state="empty"
                  icon={
                    search || category || filterKey ? <Search /> : trash ? <Trash2 /> : <Upload />
                  }
                  title={t(
                    search || category || filterKey
                      ? 'files.emptySearch'
                      : trash
                        ? 'files.emptyTrash'
                        : 'files.empty',
                  )}
                  description={t(
                    search || category || filterKey
                      ? 'files.emptySearchDescription'
                      : trash
                        ? 'files.emptyTrashDescription'
                        : 'files.emptyDescription',
                  )}
                  {...(search || category || filterKey
                    ? {
                        actionLabel: t('files.clearFileFilters'),
                        onAction: () => navigate({ parent, ...(trash ? { trash: 'true' } : {}) }),
                      }
                    : !trash
                      ? {
                          actionLabel: t('files.upload'),
                          onAction: () => {
                            void port
                              .chooseFiles()
                              .then(enqueue)
                              .catch((error: unknown) => setNotice(errorText(error)));
                          },
                        }
                      : {})}
                />
              </div>
            ) : (
              <div
                role={preferences.view === 'list' ? 'table' : undefined}
                aria-label={preferences.view === 'list' ? title : undefined}
                className={
                  preferences.view === 'grid'
                    ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6'
                    : 'flex flex-col divide-y divide-border'
                }
              >
                {preferences.view === 'list' ? (
                  <FileListHeader
                    preferences={preferences}
                    onSort={(sort) =>
                      savePreferences({
                        ...preferences,
                        sort,
                        desc: preferences.sort === sort ? !preferences.desc : false,
                      })
                    }
                  />
                ) : null}
                {visibleItems.map((entry, index) => (
                  <FileItem
                    key={entry.id}
                    entry={entry}
                    annotation={annotationMap.get(entry.id)}
                    iconRule={
                      entry.kind === 'file'
                        ? iconsByExtension.get(fileIconExtension(entry.name))
                        : undefined
                    }
                    onTag={(name) =>
                      navigate({
                        filter: encodeFileFilters({
                          scope: 'all',
                          tagFilter: { names: [name], match: 'all' },
                        }),
                      })
                    }
                    view={preferences.view}
                    folderClick={preferenceSnapshot?.configuration.folderClick}
                    columns={preferences.columns}
                    selected={selectedIds.has(entry.id)}
                    cut={
                      clipboard.mode === 'cut' &&
                      clipboard.entries.some((item) => item.id === entry.id)
                    }
                    tabStop={focusedEntry === entry.id || (!focusedEntry && index === 0)}
                    onFocus={() => setFocusedEntry(entry.id)}
                    onOpen={() => {
                      if (trash) openDialog('restore', [entry]);
                      else if (entry.kind === 'folder') navigate({ parent: entry.id });
                      else void showPreview(entry);
                    }}
                    onSelect={(gesture) => selectEntry(entry.id, gesture)}
                    onChecked={(checked) => {
                      setSelectionAnchor(entry.id);
                      setSelected((current) =>
                        checked
                          ? [...new Set([...current, entry.id])]
                          : current.filter((id) => id !== entry.id),
                      );
                    }}
                    onContext={() => {
                      setContextEntry(entry.id);
                      setSelectionAnchor(entry.id);
                      if (!selectedIds.has(entry.id)) setSelected([entry.id]);
                    }}
                    thumbnail={
                      preferences.thumbnails &&
                      thumbnailIds.has(entry.id) &&
                      listing &&
                      entry.sizeBytes <= listing.maxThumbnailBytes ? (
                        <FileMedia
                          key={entry.id + ':' + entry.contentRevision}
                          entry={entry}
                          mode="thumbnail"
                          maxBytes={listing.maxThumbnailBytes}
                        />
                      ) : null
                    }
                    actions={
                      <MenuButton
                        label={<MoreHorizontal className="size-5" />}
                        ariaLabel={t('files.actionsFor', { name: entry.name })}
                        triggerVariant="icon"
                        triggerSize="sm"
                        isOpen={contextEntry === entry.id}
                        onOpenChange={(open) => setContextEntry(open ? entry.id : undefined)}
                        {...(trash
                          ? {
                              items: [
                                {
                                  id: 'restore',
                                  label: t('files.restore'),
                                  icon: <RotateCcw className="size-4" />,
                                },
                                ...(entry.kind === 'shortcut'
                                  ? [
                                      {
                                        id: 'purge',
                                        label: t('files.navigation.purge'),
                                        icon: <Trash2 className="size-4" />,
                                        tone: 'danger' as const,
                                      },
                                    ]
                                  : [
                                      {
                                        id: 'purge-file',
                                        label: t('files.trashPurge.permanent'),
                                        icon: <Trash2 className="size-4" />,
                                        tone: 'danger' as const,
                                      },
                                    ]),
                              ],
                            }
                          : {
                              groups: [
                                {
                                  id: 'actions',
                                  label: t('files.explorer.menuActions'),
                                  items: [
                                    {
                                      id: 'open',
                                      label: t('files.explorer.open'),
                                      icon: <Eye className="size-4" />,
                                    },
                                    ...(entry.kind === 'file'
                                      ? [
                                          {
                                            id: 'open-with',
                                            label: openWithLabel,
                                            icon: <ExternalLink className="size-4" />,
                                          },
                                          ...(entry.mediaType.startsWith('text/') ||
                                          isMarkdownFile(entry) ||
                                          /\.txt$/i.test(entry.name)
                                            ? [
                                                {
                                                  id: 'edit',
                                                  label: t('files.edit'),
                                                  icon: <Pencil className="size-4" />,
                                                },
                                              ]
                                            : []),
                                          ...(archiveFile(entry)
                                            ? [
                                                {
                                                  id: 'browse-archive',
                                                  label: t('files.archives.title'),
                                                  icon: <Archive className="size-4" />,
                                                },
                                              ]
                                            : []),
                                          {
                                            id: 'download',
                                            label: t('files.download'),
                                            icon: <Download className="size-4" />,
                                          },
                                        ]
                                      : []),
                                    ...(entry.kind === 'shortcut'
                                      ? []
                                      : [
                                          {
                                            id: 'share',
                                            label: t('files.share'),
                                            icon: <Share2 className="size-4" />,
                                          },
                                        ]),
                                    ...(entry.kind === 'file'
                                      ? [
                                          {
                                            id: 'direct-link',
                                            label: t('files.directLinks.get'),
                                            icon: <Link2 className="size-4" />,
                                          },
                                        ]
                                      : []),
                                  ],
                                },
                                {
                                  id: 'organize',
                                  label: t('files.explorer.menuOrganize'),
                                  items: [
                                    {
                                      id: 'rename',
                                      label: t('files.rename'),
                                      icon: <Pencil className="size-4" />,
                                    },
                                    {
                                      id: 'move',
                                      label: t('files.move'),
                                      icon: <FolderInput className="size-4" />,
                                    },
                                    {
                                      id: 'copy',
                                      label: t('files.copy'),
                                      icon: <Copy className="size-4" />,
                                    },
                                    ...(entry.kind === 'shortcut'
                                      ? []
                                      : [
                                          {
                                            id: 'queue-copy',
                                            label: t('files.explorer.copyPending'),
                                            icon: <Copy className="size-4" />,
                                            disabled: clipboard.pending,
                                          },
                                          {
                                            id: 'queue-cut',
                                            label: t('files.explorer.cutPending'),
                                            icon: <Scissors className="size-4" />,
                                            disabled: clipboard.pending,
                                          },
                                          {
                                            id: 'create-zip',
                                            label: t('files.archives.createZIP.title'),
                                            icon: <Archive className="size-4" />,
                                          },
                                        ]),
                                    ...(entry.kind === 'folder' || entry.kind === 'shortcut'
                                      ? [
                                          {
                                            id: 'pin',
                                            label: t('files.navigation.pin'),
                                            icon: <Pin className="size-4" />,
                                          },
                                        ]
                                      : []),
                                  ],
                                },
                                {
                                  id: 'details',
                                  label: t('files.explorer.menuDetails'),
                                  items: [
                                    {
                                      id: 'details',
                                      label: t('files.details'),
                                      icon: <Info className="size-4" />,
                                    },
                                    ...(entry.kind === 'file'
                                      ? [
                                          {
                                            id: 'versions',
                                            label: t('files.versions.title'),
                                            icon: <History className="size-4" />,
                                          },
                                          {
                                            id: 'upload-version',
                                            label: t('files.versions.upload'),
                                            icon: <UploadCloud className="size-4" />,
                                          },
                                        ]
                                      : []),
                                    ...(entry.kind === 'shortcut'
                                      ? []
                                      : [
                                          {
                                            id: 'access',
                                            label: t('files.access.title'),
                                            icon: <Shield className="size-4" />,
                                          },
                                        ]),
                                  ],
                                },
                                {
                                  id: 'danger',
                                  label: t('files.explorer.menuDanger'),
                                  items: [
                                    {
                                      id: 'remove',
                                      label: t('files.remove'),
                                      icon: <Trash2 className="size-4" />,
                                      tone: 'danger' as const,
                                    },
                                  ],
                                },
                              ],
                            })}
                        onAction={(action) => {
                          setContextEntry(undefined);
                          if (action === 'open') {
                            if (entry.kind === 'folder') navigate({ parent: entry.id });
                            else void showPreview(entry);
                          } else if (action === 'browse-archive')
                            void showPreview(entry, 'archive');
                          else if (action === 'open-with') void showPreview(entry, 'choose');
                          else if (action === 'create-zip')
                            setZIPSelection({ entries: [entry], parent: entry.parentId });
                          else if (action === 'versions') setVersionEntry(entry);
                          else if (action === 'upload-version') void uploadVersion(entry);
                          else if (action === 'queue-copy' || action === 'queue-cut')
                            queueClipboard(
                              action === 'queue-copy' ? 'copy' : 'cut',
                              selectedIds.has(entry.id) ? targets : [entry],
                            );
                          else if (action === 'details') void showDetails(entry);
                          else if (action === 'purge') setPurgeTarget(entry);
                          else if (action === 'purge-file')
                            setTrashSelection({ scope: 'selection', ids: [entry.id] });
                          else if (
                            action === 'pin' &&
                            (entry.kind === 'folder' || entry.kind === 'shortcut')
                          )
                            setPinTarget({ targetKind: entry.kind, targetId: entry.id });
                          else if (action === 'download') void download(entry);
                          else if (action === 'direct-link') setDirectTargets([entry]);
                          else if (action === 'share') setShareTarget(entry);
                          else if (action === 'access') setAccessTarget(entry);
                          else if (action === 'edit') reader.edit(entry);
                          else if (
                            action === 'rename' ||
                            action === 'move' ||
                            action === 'copy' ||
                            action === 'remove' ||
                            action === 'restore'
                          )
                            openDialog(action, [entry]);
                        }}
                      />
                    }
                  />
                ))}
              </div>
            )}
          </section>
          {inspectorDocked ? (
            inspectorOpen ? (
              <aside
                aria-label={t('files.explorer.inspector')}
                className="w-80 shrink-0 rounded-panel border border-border bg-surface p-4 shadow-panel"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
                  <h2
                    ref={inspectorHeading}
                    tabIndex={-1}
                    className="text-sm font-semibold text-ink"
                  >
                    {t('files.explorer.inspector')}
                  </h2>
                  <IconAction size="sm" label={t('files.close')} onPress={closeInspector}>
                    <X className="size-4" />
                  </IconAction>
                </div>
                {inspectorContent}
              </aside>
            ) : null
          ) : (
            <DrawerSurface
              triggerLabel={t('files.explorer.inspector')}
              title={t('files.explorer.inspector')}
              description=""
              closeLabel={t('files.close')}
              placement="bottom"
              isOpen={inspectorOpen}
              onOpenChange={(open) => {
                if (!open) closeInspector();
              }}
            >
              {inspectorContent}
            </DrawerSurface>
          )}
        </div>
        {listing &&
        listing.total > 0 &&
        !loading &&
        !navigating &&
        preferences.view !== 'gallery' ? (
          listing.cursorPage ? (
            preferenceReady ? (
              <CursorFilePagination
                next={!!listing.cursorPage.next}
                previous={!!listing.cursorPage.previous}
                phase={feed.phase}
                count={listing.items.length}
                bookmarked={!!cursor}
                onLoad={feed.load}
                onPrevious={() =>
                  navigate({
                    parent,
                    category,
                    trash: trash ? 'true' : '',
                    search,
                    filter: filterKey,
                    cursor: listing.cursorPage?.previous ?? '',
                  })
                }
                onRestart={restartCursor}
              />
            ) : null
          ) : (
            <NumberedFilePagination
              page={page}
              pageSize={listing.pageSize}
              total={listing.total}
              onPage={goToNumberedPage}
            />
          )
        ) : null}
        {listing && preferences.view === 'gallery' ? (
          <p className="text-xs text-ink-muted">
            {t('files.discovery.galleryBudget', { count: listing.maxGalleryEntries })}
          </p>
        ) : null}
        {listing &&
        preferences.thumbnails &&
        thumbnailIds.size > 0 &&
        listing.items.length > listing.maxGalleryEntries ? (
          <p className="text-xs text-ink-muted">
            {t('files.discovery.thumbnailBudget', { count: listing.maxGalleryEntries })}
          </p>
        ) : null}
        {listing && preferences.view === 'gallery' && pageCount > 1 ? (
          <div className="flex flex-wrap items-center gap-3">
            <Action
              variant="secondary"
              size="sm"
              disabled={currentGalleryPage === 0}
              onPress={() => {
                setGalleryPage(currentGalleryPage - 1);
                setSelected([]);
                setSelectionAnchor('');
                setFocusedEntry('');
              }}
            >
              {t('files.previousPage')}
            </Action>
            <span className="text-sm text-ink-muted">
              {t('files.galleryPage', { current: currentGalleryPage + 1, pages: pageCount })}
            </span>
            <Action
              variant="secondary"
              size="sm"
              disabled={currentGalleryPage + 1 >= pageCount}
              onPress={() => {
                setGalleryPage(currentGalleryPage + 1);
                setSelected([]);
                setSelectionAnchor('');
                setFocusedEntry('');
              }}
            >
              {t('files.nextPage')}
            </Action>
          </div>
        ) : null}
        {listing && !trash ? (
          <p className="text-xs text-ink-muted">
            {t('files.uploadLimit', {
              size: bytes(listing.maxFileBytes),
              count: listing.concurrentUploads,
            })}
          </p>
        ) : null}
      </div>
      {dialog ? (
        <DialogSurface
          triggerLabel={t(`files.${dialog.mode}`)}
          title={t(`files.${dialog.mode}`)}
          description={t(
            dialog.mode === 'remove'
              ? 'files.removeHint'
              : dialog.mode === 'move'
                ? 'files.destinationHint'
                : dialog.mode === 'restore'
                  ? 'files.restoreHint'
                  : 'files.nameHint',
          )}
          cancelLabel={t('files.cancel')}
          confirmLabel={t('files.confirm')}
          isOpen
          onOpenChange={(open) => {
            if (!open) setDialog(undefined);
          }}
          {...(dialogFailure ? { failureMessage: dialogFailure } : {})}
          onConfirm={confirmDialog}
          confirmDisabled={
            dialog.mode === 'rename'
              ? !name.trim()
              : dialog.mode === 'copy'
                ? !folders || !name.trim()
                : dialog.mode === 'move' || dialog.mode === 'restore'
                  ? !folders
                  : false
          }
        >
          {dialog.mode === 'copy' ? (
            <TextField
              label={t('files.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          ) : null}
          {dialog.mode === 'rename' ? (
            <TextField
              label={t('files.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          ) : dialog.mode === 'move' || dialog.mode === 'restore' || dialog.mode === 'copy' ? (
            <div className="space-y-3">
              <Action variant="secondary" onPress={() => setDestination('')}>
                {t('files.nav')}
              </Action>
              <p className="break-words text-sm">
                {t('files.currentDestination')}: /
                {folders?.breadcrumbs.map((entry) => entry.name).join('/')}
              </p>
              {!folders ? (
                <p role="status">{t('files.loading')}</p>
              ) : (
                <ul className="space-y-2">
                  {folders.items
                    .filter((entry) => entry.kind === 'folder')
                    .map((entry) => (
                      <li key={entry.id}>
                        <Action variant="quiet" onPress={() => setDestination(entry.id)}>
                          {entry.name}
                        </Action>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ) : (
            <ul className="space-y-2 text-sm">
              {dialog.targets.map((entry) => (
                <li key={entry.id} className="break-words">
                  {entry.name}
                </li>
              ))}
            </ul>
          )}
        </DialogSurface>
      ) : null}
      {advancedOpen ? (
        <AdvancedSearchDialog
          filters={filters}
          search={search}
          parent={parent}
          onClose={() => setAdvancedOpen(false)}
          onApply={(next) => {
            const encoded = encodeFileFilters(next);
            setAdvancedOpen(false);
            navigate({ parent, category, trash: trash ? 'true' : '', filter: encoded });
          }}
        />
      ) : null}
      {viewOptionsOpen && preferenceSnapshot ? (
        <ViewOptionsDialog
          preferences={preferences}
          maxPageSize={listing?.maxPageSize}
          snapshot={preferenceSnapshot}
          parentId={preferenceParent}
          busy={preferenceBusy}
          failure={preferenceFailure}
          onLoadServer={async () => {
            if (preferenceBusy) return;
            setPreferenceBusy(true);
            setPreferenceFailure('');
            const scope = preferenceScope;
            try {
              const snapshot = await port.loadPreferences(undefined, 'server');
              if (preferenceScopeRef.current !== scope) return;
              setPreferenceSnapshot(snapshot);
              applyPreferences(resolveFileView(snapshot.configuration, preferenceParent));
              setViewOptionsOpen(false);
            } catch (error) {
              if (preferenceScopeRef.current === scope)
                setPreferenceFailure(t('files.preferences.failure', { reason: errorText(error) }));
            } finally {
              setPreferenceBusy(false);
            }
          }}
          onClose={() => setViewOptionsOpen(false)}
          onSave={persistPreferences}
        />
      ) : null}
      {accessTarget ? (
        <Suspense fallback={<p role="status">{t('files.access.loading')}</p>}>
          <FileAccessDialog
            entry={accessTarget}
            onClose={() => setAccessTarget(undefined)}
            onSaved={() => {
              setAccessTarget(undefined);
              setNotice(t('files.access.saved'));
              reload();
            }}
          />
        </Suspense>
      ) : null}
      {shareTarget ? (
        <ShareDialog entry={shareTarget} onClose={() => setShareTarget(undefined)} />
      ) : null}
      {directTargets ? (
        <Suspense>
          <DirectLinksDialog entries={directTargets} onClose={() => setDirectTargets(undefined)} />
        </Suspense>
      ) : null}
      {saveShortcut ? (
        <SaveShortcutDialog
          parentId={parent}
          onClose={() => setSaveShortcut(false)}
          onSaved={() => {
            setSaveShortcut(false);
            reload();
          }}
        />
      ) : null}
      {trash && trashSelection ? (
        <Suspense>
          <TrashPurgeDialog
            selection={trashSelection}
            onClose={() => setTrashSelection(undefined)}
            onPurged={(receipt) => {
              setSelected([]);
              setNotice(
                t('files.trashPurge.done', {
                  entries: receipt.entryCount,
                  bytes: bytes(receipt.bytes),
                }),
              );
              reload();
              if (page > 1)
                navigate({ parent, category, trash: 'true', search, filter: filterKey });
            }}
          />
        </Suspense>
      ) : null}
      {purgeTarget ? (
        <ShortcutActionDialog
          entry={purgeTarget}
          action="purge"
          onClose={() => setPurgeTarget(undefined)}
          onChanged={() => {
            setPurgeTarget(undefined);
            reload();
          }}
        />
      ) : null}
      {pinTarget ? (
        <PinDialog
          target={pinTarget}
          onClose={() => setPinTarget(undefined)}
          onChanged={() => {
            setPinTarget(undefined);
            reload();
          }}
        />
      ) : null}
      <FileApplicationSelection reader={reader} />
      {versionEntry ? (
        <VersionsPanel
          entry={versionEntry}
          onClose={() => setVersionEntry(undefined)}
          onSaved={reload}
        />
      ) : null}
      {detail ? (
        <AnnotationPanel
          onVersions={() => {
            setVersionEntry(detail);
            setDetail(undefined);
          }}
          key={detail.id}
          entry={detail}
          onClose={() => setDetail(undefined)}
          onSaved={reload}
        />
      ) : null}
      {tagsBatch && listing ? (
        <TagsBatchDialog
          mode={tagsBatch.mode}
          targets={tagsBatch.targets}
          limits={listing.annotationLimits}
          onClose={() => setTagsBatch(undefined)}
          onUpdated={() => {
            setTagsBatch(undefined);
            setNotice(t('files.annotations.batchDone'));
            reload();
          }}
        />
      ) : null}
      {historySettingsOpen ? (
        <Suspense fallback={<p role="status">{t('files.retention.loading')}</p>}>
          <HistorySettingsDialog onClose={() => setHistorySettingsOpen(false)} />
        </Suspense>
      ) : null}
      {zipSelection ? (
        <Suspense fallback={<p role="status">{t('files.previewLoading')}</p>}>
          <ArchiveCreateDialog
            entries={zipSelection.entries}
            initialParent={zipSelection.parent}
            onClose={() => setZIPSelection(undefined)}
            onCreated={(task) => {
              setZIPSelection(undefined);
              setQueuedZIPName(task.sourceName);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
