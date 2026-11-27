'use client';
import { WorkspaceBrand, WorkspaceHeader } from '@neocloud/surface-foundation/layout';
import { useFrontendTranslation } from '@neocloud/i18n';
import { CurrentSiteLogo, useSiteProfile } from '@neocloud/surface/administration/runtime';
import { useFileActionFeedback } from './use-file-action-feedback';
import { Action } from '@neocloud/ui-adapter/action';
import { useNarrowLayout } from '@neocloud/ui-adapter/browser-layout';
import { IconAction } from '@neocloud/ui-adapter/icon-action';
import { MenuButton } from '@neocloud/ui-adapter/menu-button';
import { NavigationItem } from '@neocloud/ui-adapter/destination-navigation';
import { MobileNavigation } from '@neocloud/ui-adapter/mobile-navigation';
import { DrawerSurface } from '@neocloud/ui-adapter/overlays';
import { ProgressMeter } from '@neocloud/ui-adapter/progress-meter';
import { SearchBox } from '@neocloud/ui-adapter/search-box';
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { formatFileBytes } from '../../../src/files/format';
import {
  fileApplicationDevice,
  type CreationTemplate,
  type FileApplicationPolicy,
} from '../../../src/files/file-applications';
import {
  Cloud,
  FileGlyph,
  FolderPlus,
  HardDrive,
  Home,
  Download,
  Link2,
  Share2,
  Users,
  UserRound,
  ChevronDown,
  ChevronRight,
  Menu,
  Music,
  Package,
  RefreshCw,
  Settings,
  Trash2,
  Upload,
} from '../../../src/files/icons';
import {
  FilesError,
  type FileBrowseQuery,
  type FileListing,
  type UploadCandidate,
} from '../../../src/files/model';
import {
  FileAccountTools,
  useFileMusic,
  useFiles,
  useTransferSnapshot,
} from '../../../src/files/runtime';
import { transferMatches } from '../../../src/files/transfers';
import {
  defaultFileSidebarPreferences,
  type FileSidebarPreferences,
} from '../../../src/files/sidebar-preferences';
import { useDirectoryTree } from './use-directory-tree';
import { useWorkspaceRevision, WorkspaceCreateContext } from '../stores/workspace';
import { ExplorerNavigation } from './explorer-navigation';
import { FileLink } from './file-link';
import { FileCategoryMenu } from './file-categories';
import { fileCategoryKeys } from './file-category-keys';
import { PinnedLinks } from './pinned-links';
import { useReaderWorkspace } from './reader-workspace-context';
import type { CreateAction } from './workspace-create';
import type { TrashPurgeSelection } from '../../../src/files/trash-purge';
const TrashPurgeDialog = lazy(() => import('./trash-purge-dialog'));
const TrashRetentionDialog = lazy(() => import('./trash-retention-dialog'));
const allTrash: TrashPurgeSelection = { scope: 'all', ids: [] };
const Create = lazy(() =>
  import('./workspace-create').then((module) => ({ default: module.WorkspaceCreate })),
);
const Transfers = lazy(() =>
  import('./transfer-panel').then((module) => ({ default: module.TransferPanel })),
);
const DirectoryTree = lazy(() =>
  import('./directory-tree').then((module) => ({ default: module.DirectoryTree })),
);
export function FileWorkspace({
  pathname,
  query,
  children,
}: {
  pathname: string;
  query: FileBrowseQuery;
  children: ReactNode;
}) {
  const reader = useReaderWorkspace();
  const music = useFileMusic();
  const port = useFiles(),
    snapshot = useTransferSnapshot(),
    { t, locale } = useFrontendTranslation();
  const { profile } = useSiteProfile();
  const desktopNavigation = !useNarrowLayout();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const siteName = profile?.name || t('files.brand');
  const reportAction = useFileActionFeedback(pathname);
  const [revision, setRevision] = useWorkspaceRevision();
  const [emptyTrash, setEmptyTrash] = useState(false);
  const [trashRetention, setTrashRetention] = useState(false);
  const [storage, setStorage] = useState<FileListing>(),
    [storageFailure, setStorageFailure] = useState(''),
    [notice, setNotice] = useState(''),
    [sidebarPreference] = useState(() => {
      try {
        return { preferences: port.loadSidebarPreferences(), failed: false };
      } catch {
        return { preferences: defaultFileSidebarPreferences, failed: true };
      }
    }),
    [sidebarSettings, setSidebarSettings] = useState(sidebarPreference.preferences),
    [searchDraft, setSearchDraft] = useState<{ scope: string; value: string }>(),
    [tray, setTray] = useState<string | null>(null);
  const [create, setCreate] = useState<{
    action: CreateAction;
    candidates?: readonly UploadCandidate[];
    template?: CreationTemplate;
  }>();
  const [creationPolicy, setCreationPolicy] = useState<
    | {
        policy: FileApplicationPolicy;
        device: ReturnType<typeof fileApplicationDevice>;
      }
    | 'error'
  >();
  const creationRequest = useRef<AbortController>(null);
  function loadCreationMenu(open: boolean) {
    creationRequest.current?.abort();
    if (!open) return;
    const controller = new AbortController();
    creationRequest.current = controller;
    const device = fileApplicationDevice(window.innerWidth);
    setCreationPolicy(undefined);
    void port.readActiveFileApplications(controller.signal).then(
      (policy) => {
        if (!controller.signal.aborted) setCreationPolicy({ policy, device });
      },
      () => {
        if (!controller.signal.aborted) setCreationPolicy('error');
      },
    );
  }
  const templates =
    creationPolicy && creationPolicy !== 'error'
      ? creationPolicy.policy.items.flatMap((item) => {
          const action = item.id;
          if (
            (action !== 'text' && action !== 'markdown' && action !== 'drawio') ||
            !item.enabled ||
            !item.canCreate ||
            (item.platform !== 'all' && item.platform !== creationPolicy.device)
          )
            return [];
          return item.newFiles.map((mapping) => ({
            id: `new-file:${action}:${mapping.extension}`,
            action,
            title: mapping.label
              ? `${mapping.label} (.${mapping.extension})`
              : t(
                  action === 'text'
                    ? 'files.newText'
                    : action === 'drawio'
                      ? 'files.newDrawio'
                      : 'files.newMarkdown',
                ),
            extension: mapping.extension,
            builtIn: !item.customNewFiles,
          }));
        })
      : [];
  const isFiles = pathname === port.destinationHref('files'),
    isTransfers = pathname === port.destinationHref('transfers');
  const isTrash = isFiles && query.trash === 'true';
  useEffect(() => () => creationRequest.current?.abort(), [desktopNavigation, isTrash, port]);
  const collapsed = sidebarSettings.collapsed;
  const directoryParent =
    isFiles && query.trash !== 'true' && !query.category ? (query.parent ?? '') : undefined;
  const directoryTree = useDirectoryTree(
    port,
    revision + ':' + snapshot.completedRevision,
    directoryParent,
    sidebarSettings.autoExpandTree,
  );
  const errorText = useCallback(
    (error: unknown) =>
      t('files.errors.' + (error instanceof FilesError ? error.code : 'unavailable')),
    [t],
  );
  const scope = pathname + JSON.stringify(query);
  const search =
    searchDraft?.scope === scope ? searchDraft.value : isFiles ? (query.search ?? '') : '';
  const setSearch = (value: string) => setSearchDraft({ scope, value });
  useEffect(() => {
    const controller = new AbortController();
    void port
      .list(
        {
          parent: '',
          category: '',
          trash: false,
          search: '',
          sort: 'name',
          desc: false,
          pageSize: 1,
        },
        controller.signal,
      )
      .then((value) => {
        if (!controller.signal.aborted) {
          setStorage(value);
          setStorageFailure('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setStorage(undefined);
          setStorageFailure(errorText(error));
        }
      });
    return () => controller.abort();
  }, [port, revision, snapshot.completedRevision, pathname, errorText]);
  useEffect(
    () => (isFiles ? undefined : port.subscribeShortcuts(() => port.focusSearch(), ['search'])),
    [port, isFiles],
  );
  // 根列表继续拥有其原有拖放；其他文件页面先确认目标，避免两个订阅重复入队。
  useEffect(
    () =>
      isFiles
        ? undefined
        : port.subscribeDrop((candidates) =>
            setCreate((current) => {
              if (current) {
                for (const candidate of candidates) port.releaseCandidate(candidate.id);
                return current;
              }
              return { action: 'upload', candidates };
            }),
          ),
    [port, isFiles],
  );
  const refresh = () => setRevision((value) => value + 1);
  const navigationGroups = [
    {
      id: 'collaboration',
      items: [
        { target: 'shared', label: 'files.navigation.title', icon: <Users /> },
        { target: 'shares', label: 'files.myShares', icon: <Share2 /> },
        { target: 'connections', label: 'files.connections.title', icon: <Link2 /> },
      ],
    },
    {
      id: 'activity',
      items: [
        { target: 'transfers', label: 'files.transferCenter', icon: <Upload /> },
        { target: 'downloads', label: 'files.downloads.title', icon: <Download /> },
        { target: 'tasks', label: 'files.archives.tasks.title', icon: <Package /> },
      ],
    },
    {
      id: 'administration',
      items: [
        { target: 'workspace', label: 'files.management', icon: <Settings /> },
        { target: 'account', label: 'files.account', icon: <UserRound /> },
      ],
    },
  ] as const;
  const categoryItems = [
    { key: '', label: 'files.nav', icon: <Home /> },
    ...fileCategoryKeys.map((key) => ({
      key,
      label: 'files.' + key,
      icon: (
        <FileGlyph kind="file" size="small" mediaType={(key === 'document' ? 'text' : key) + '/'} />
      ),
    })),
  ];
  const activeCount = snapshot.items.filter((item) => transferMatches(item, 'active')).length;
  const searchQuery = (value: string): FileBrowseQuery => ({
    ...(isFiles ? query : {}),
    search: value,
    page: '',
    cursor: '',
  });
  function toggleSidebar() {
    saveSidebar({ ...sidebarSettings, collapsed: !collapsed });
  }
  function saveSidebar(next: FileSidebarPreferences) {
    try {
      port.saveSidebarPreferences(next);
      setSidebarSettings(next);
    } catch {
      setNotice(t('files.workspace.readFailed'));
    }
  }
  const renderNavigation = (close: () => void, rail: boolean, mobile: boolean) => (
    <div className="surface-file-navigation flex h-full min-h-0 flex-col">
      <div
        className={
          rail
            ? 'flex shrink-0 flex-col items-center gap-1'
            : 'flex shrink-0 items-center justify-between gap-2'
        }
      >
        <FileLink
          target="files"
          title={siteName}
          onNavigate={close}
          className="flex min-w-0 items-center gap-3 px-4 py-2 text-base font-semibold"
        >
          <CurrentSiteLogo
            className="size-6 shrink-0"
            fallback={<Cloud className="size-6 shrink-0 text-brand" />}
          />
          <span className={rail ? 'sr-only' : 'truncate'}>{siteName}</span>
        </FileLink>
        {!mobile ? (
          <IconAction
            label={t(collapsed ? 'files.workspace.expand' : 'files.workspace.collapse')}
            onPress={toggleSidebar}
            tooltip
          >
            <Menu className="size-6" />
          </IconAction>
        ) : null}
      </div>
      {!mobile && desktopNavigation && !isTrash ? (
        <div className={rail ? 'mt-3 flex shrink-0 justify-center' : 'mt-3 flex shrink-0 px-3'}>
          {renderCreationMenu(rail)}
        </div>
      ) : null}
      <nav
        aria-label={t('files.nav')}
        className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pb-4"
      >
        {!rail ? (
          <h2 className="px-4 pb-2 pt-1 text-xs font-medium text-ink-muted">
            {t('files.workspace.library')}
          </h2>
        ) : null}
        {categoryItems
          .filter((item) => mobile || !item.key)
          .map((item) => {
            const active =
              isFiles &&
              query.trash !== 'true' &&
              (query.category ?? '') === item.key &&
              (item.key !== '' || !query.parent);
            const link = (
              <NavigationItem
                key={item.key}
                href={port.destinationHref('files', { category: item.key })}
                label={t(item.label)}
                icon={item.icon}
                selected={active}
                compact={rail}
                onNavigate={() => {
                  port.navigate('files', { category: item.key });
                  close();
                }}
              />
            );
            return item.key === '' && !rail ? (
              <Fragment key={item.key}>
                <div className="flex min-w-0 items-center gap-1 [&>a]:flex-1">
                  {link}
                  <IconAction
                    expanded={directoryTree.snapshot.rootOpen}
                    disabled={!directoryTree.snapshot.ready}
                    label={t(
                      directoryTree.snapshot.rootOpen
                        ? 'files.tree.collapseRoot'
                        : 'files.tree.expandRoot',
                    )}
                    onPress={directoryTree.controller.toggleRoot}
                  >
                    {directoryTree.snapshot.rootOpen ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </IconAction>
                </div>
                {directoryTree.snapshot.rootOpen ? (
                  <Suspense
                    fallback={
                      <p role="status" className="text-xs text-ink-muted">
                        {t('files.tree.loading')}
                      </p>
                    }
                  >
                    <DirectoryTree
                      snapshot={directoryTree.snapshot}
                      controller={directoryTree.controller}
                      currentParent={directoryParent}
                      automatic={sidebarSettings.autoExpandTree}
                      onAutomaticChange={(autoExpandTree) =>
                        saveSidebar({ ...sidebarSettings, autoExpandTree })
                      }
                      onNavigate={close}
                    />
                  </Suspense>
                ) : null}
              </Fragment>
            ) : (
              link
            );
          })}
        <NavigationItem
          href={port.destinationHref('files', { trash: 'true' })}
          label={t('files.trash')}
          icon={<Trash2 />}
          selected={isFiles && query.trash === 'true'}
          compact={rail}
          onNavigate={() => {
            port.navigate('files', { trash: 'true' });
            close();
          }}
        />
        {navigationGroups.map((group) => (
          <section key={group.id} aria-label={t('files.workspace.' + group.id)} className="pt-3">
            {!rail ? (
              <h2 className="px-4 pb-2 text-xs font-medium text-ink-muted">
                {t('files.workspace.' + group.id)}
              </h2>
            ) : (
              <div className="mx-3 mb-2 border-t border-border" />
            )}
            {group.items.map((item) => {
              const active = pathname === port.destinationHref(item.target);
              return (
                <NavigationItem
                  key={item.target}
                  href={port.destinationHref(item.target)}
                  label={t(item.label)}
                  icon={item.icon}
                  selected={active}
                  compact={rail}
                  onNavigate={() => {
                    port.navigate(item.target);
                    close();
                  }}
                />
              );
            })}
          </section>
        ))}
        {!rail ? (
          <div data-file-pins-region className="pt-3 pb-2">
            <PinnedLinks refreshKey={revision} onNavigate={close} />
          </div>
        ) : null}
      </nav>
      {!rail ? (
        <section
          className="mt-2 shrink-0 space-y-2 border-t border-border px-3 pt-3 pb-1 text-xs text-ink-muted"
          aria-label={t('files.storage')}
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              <HardDrive className="size-4" />
              {t('files.storage')}
            </h2>
            <IconAction
              size="sm"
              label={t('files.workspace.storageRefresh')}
              tooltip
              onPress={refresh}
            >
              <RefreshCw className="size-3.5" />
            </IconAction>
          </div>
          {storageFailure ? (
            <p role="alert">
              {t('files.workspace.quotaUnknown')} · {storageFailure}
            </p>
          ) : storage ? (
            <ProgressMeter
              value={Math.min(100, Math.round((storage.usedBytes / storage.quotaBytes) * 100))}
              label={
                formatFileBytes(storage.usedBytes) + ' / ' + formatFileBytes(storage.quotaBytes)
              }
            />
          ) : (
            <p role="status">{t('files.workspace.quotaLoading')}</p>
          )}
        </section>
      ) : null}
    </div>
  );
  function renderCreationMenu(iconOnly: boolean) {
    return (
      <MenuButton
        ariaLabel={t('files.new')}
        triggerVariant="primary"
        label={
          <span aria-hidden="true" className="flex items-center gap-1.5">
            <FolderPlus className="size-4" />
            {iconOnly ? null : <span>{t('files.new')}</span>}
          </span>
        }
        items={[
          { id: 'upload', label: t('files.upload') },
          { id: 'directory', label: t('files.uploadDirectory') },
          { id: 'clipboard', label: t('files.uploadClipboard') },
          { id: 'folder', label: t('files.newFolder') },
          ...templates.map(({ id, title }) => ({ id, label: title })),
        ]
          .map((item) => ({ ...item, disabled: !storage }))
          .concat([
            ...(storage && (!creationPolicy || creationPolicy === 'error')
              ? [
                  {
                    id: 'creation-status',
                    label:
                      creationPolicy === 'error'
                        ? locale.startsWith('zh')
                          ? '无法读取新建文件映射，重新打开可重试。'
                          : 'File mappings could not be loaded. Reopen the menu to retry.'
                        : t('files.previewLoading'),
                    disabled: true,
                  },
                ]
              : []),
            { id: 'downloads', label: t('files.downloads.title'), disabled: false },
          ])}
        onOpenChange={loadCreationMenu}
        onAction={(action) => {
          if (action === 'downloads') port.navigate('downloads');
          else if (action === 'clipboard') {
            port.focusFiles();
            reportAction(t('files.workspace.clipboard'));
          } else if (action === 'folder' || action === 'upload' || action === 'directory')
            setCreate({ action });
          else {
            const template = templates.find((item) => item.id === action);
            if (template) setCreate({ action: template.action, template });
          }
        }}
      />
    );
  }
  return (
    <div
      data-file-workspace
      inert={reader.foreground}
      className="surface-file-mobile-root fixed inset-0 flex h-dvh flex-col overflow-clip bg-canvas font-sans text-ink"
    >
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ExplorerNavigation
          collapsed={collapsed}
          onFocusFiles={port.focusFiles}
          open={mobileNavigationOpen}
          onOpenChange={setMobileNavigationOpen}
        >
          {(close, mobile) => renderNavigation(close, collapsed && !mobile, mobile)}
        </ExplorerNavigation>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div data-file-workspace-header className="surface-file-workspace-toolbar shrink-0">
            <WorkspaceHeader
              brand={
                <div className="min-w-0 md:hidden">
                  <WorkspaceBrand
                    name={siteName}
                    mark={
                      <CurrentSiteLogo
                        className="size-5 shrink-0"
                        fallback={<Cloud className="size-4" />}
                      />
                    }
                  />
                </div>
              }
              navigation={
                <div className="md:hidden">
                  <IconAction
                    size="sm"
                    label={t('files.explorer.navigation')}
                    onPress={() => setMobileNavigationOpen(true)}
                  >
                    <Menu />
                  </IconAction>
                </div>
              }
              searchMode={isFiles ? 'below' : 'desktop'}
              search={
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <form
                    data-file-workspace-search
                    className="flex min-w-0 flex-1 items-center gap-1.5 md:max-w-lg"
                    onKeyDownCapture={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setSearch(isFiles ? (query.search ?? '') : '');
                        port.focusFiles();
                      }
                    }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      port.navigate('files', searchQuery(search));
                    }}
                  >
                    <SearchBox
                      label={t('files.search')}
                      placeholder={t('files.searchPlaceholder')}
                      value={search}
                      onValueChange={(nextValue) => {
                        setSearch(nextValue);
                        if (!nextValue && isFiles && query.search) {
                          port.navigate('files', searchQuery(''));
                        }
                      }}
                    />
                  </form>
                  <div className="relative">
                    <IconAction
                      label={`${t('files.workspace.queue')} ${t('files.workspace.queueCount', { count: activeCount })}`}
                      tooltip
                      onPress={() => {
                        if (isTransfers) port.focusFiles();
                        else setTray(pathname);
                      }}
                    >
                      <Upload className="size-5" />
                    </IconAction>
                    {activeCount > 0 ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-brand px-1 text-xs font-semibold leading-4 text-on-brand"
                      >
                        {activeCount}
                      </span>
                    ) : null}
                  </div>
                </div>
              }
              tools={
                <>
                  {!isFiles ? (
                    <div className="hidden md:block">
                      <FileCategoryMenu
                        onSelect={(category) => port.navigate('files', { category })}
                      />
                    </div>
                  ) : null}
                  {isTrash ? (
                    <>
                      <Action
                        size="sm"
                        variant="danger"
                        leadingIcon={<Trash2 className="size-4" />}
                        onPress={() => setEmptyTrash(true)}
                      >
                        {t('files.trashPurge.empty')}
                      </Action>
                      <Action
                        size="sm"
                        variant="quiet"
                        leadingIcon={<Settings className="size-4" />}
                        onPress={() => setTrashRetention(true)}
                      >
                        {t('files.trashRetention.title')}
                      </Action>
                    </>
                  ) : !desktopNavigation ? (
                    <div className="md:hidden">{renderCreationMenu(true)}</div>
                  ) : null}
                  {music?.active ? (
                    <span data-file-dock-trigger>
                      <IconAction
                        size="sm"
                        label={t('files.viewer.music')}
                        expanded={reader.dockOpen}
                        onPress={reader.toggleDock}
                      >
                        <Music />
                      </IconAction>
                    </span>
                  ) : null}
                </>
              }
              account={<FileAccountTools />}
            />
          </div>
          {notice || sidebarPreference.failed ? (
            <p role="status" className="px-4 py-2 text-sm">
              {notice || t('files.workspace.readFailed')}
            </p>
          ) : null}
          <main
            id="main-content"
            tabIndex={-1}
            data-file-scroll-region
            className="surface-file-content min-h-0 min-w-0 flex-1 overflow-auto bg-canvas px-3 pb-14 pt-2 md:px-4 md:pb-3"
          >
            <WorkspaceCreateContext value={(action) => setCreate({ action })}>
              {children}
            </WorkspaceCreateContext>
          </main>
        </div>
      </div>
      <MobileNavigation
        label={t('files.workspace.mobileNavigation')}
        value={isTransfers ? 'transfers' : isFiles ? 'files' : undefined}
        items={[
          {
            id: 'files',
            label: t('files.workspace.allFiles'),
            icon: <Home />,
            href: port.destinationHref('files'),
          },
          { id: 'categories', label: t('files.workspace.mobileCategories'), icon: <Menu /> },
          {
            id: 'transfers',
            label: t('files.transferCenter'),
            icon: <Upload />,
            href: port.destinationHref('transfers'),
          },
        ]}
        onSelect={(id) => {
          if (id === 'categories') setMobileNavigationOpen(true);
          else port.navigate(id === 'transfers' ? 'transfers' : 'files');
        }}
      />
      {isTrash && emptyTrash ? (
        <Suspense>
          <TrashPurgeDialog
            selection={allTrash}
            onClose={() => setEmptyTrash(false)}
            onPurged={(receipt) => {
              reportAction(
                t('files.trashPurge.done', {
                  entries: receipt.entryCount,
                  bytes: formatFileBytes(receipt.bytes),
                }),
              );
              setRevision((value) => value + 1);
              if (query.cursor || (query.page && query.page !== '1'))
                port.navigate('files', { ...query, page: '', cursor: '' });
            }}
          />
        </Suspense>
      ) : null}
      {isTrash && trashRetention ? (
        <Suspense>
          <TrashRetentionDialog onClose={() => setTrashRetention(false)} />
        </Suspense>
      ) : null}
      {create ? (
        <Suspense fallback={<p role="status">{t('files.previewLoading')}</p>}>
          <Create
            action={create.action}
            initialParent={isFiles && query.trash !== 'true' ? (query.parent ?? '') : ''}
            {...(create.candidates ? { candidates: create.candidates } : {})}
            {...(create.template ? { template: create.template } : {})}
            onClose={() => setCreate(undefined)}
            onChanged={(queued) => {
              setCreate(undefined);
              refresh();
              reportAction(t(queued ? 'files.workspace.queued' : 'files.operationDone'));
              if (queued && !isTransfers) setTray(pathname);
            }}
          />
        </Suspense>
      ) : null}
      {tray === pathname && !isTransfers ? (
        <DrawerSurface
          isOpen
          placement="right"
          triggerLabel={t('files.workspace.queue')}
          title={t('files.workspace.queue')}
          description={t('files.transferResumeHint')}
          closeLabel={t('files.close')}
          onOpenChange={(open) => setTray(open ? pathname : null)}
        >
          <Suspense fallback={<p>{t('files.previewLoading')}</p>}>
            <Transfers compact />
          </Suspense>
        </DrawerSurface>
      ) : null}
    </div>
  );
}
