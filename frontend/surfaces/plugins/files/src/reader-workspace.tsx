'use client';

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import {
  fileApplicationDevice,
  type FileApplicationID,
  type FileApplicationPolicy,
} from '../../../src/files/file-applications';
import { FilesError, type FileEntry, type FilesPort } from '../../../src/files/model';
import {
  useFileMusic,
  useFiles,
  useReaderPersistence,
  type ReaderBookmark,
  type ReaderPersistence,
} from '../../../src/files/runtime';
import { useWorkspaceRevision } from '../stores/workspace';
import { FileReader } from './file-reader';
import {
  makeReaderSession,
  readerApplications,
  readReaderLimits,
  type MediaReaderSession,
  type OpenReaderSession,
} from './file-reader-session';
import { ReaderWorkspaceContext } from './reader-workspace-context';
import {
  ReaderSurfaceContext,
  type ViewerDraftState,
  type ViewerPresentation,
} from './reader-surface-context';
import { ReaderDock } from './reader-dock';
import { MediaShelf } from './media-shelf';

const limit = 8;
const musicApplication = 'music';
const readerKey = (item: ReaderBookmark) => JSON.stringify([item.fileId, item.application]);
const readerHref = (item: ReaderBookmark) =>
  '/home/view?' + new URLSearchParams({ file: item.fileId, app: item.application }).toString();

export type OpenFile = {
  bookmark: ReaderBookmark;
  entry?: FileEntry;
  session?: OpenReaderSession;
  applicationLabel?: string;
  blocked?: string;
  closeSequence: number;
  draftState: ViewerDraftState;
};

function isVideo(item: OpenFile) {
  return item.bookmark.application === 'video';
}

async function checkBookmark(
  port: FilesPort,
  bookmark: ReaderBookmark,
  policy: FileApplicationPolicy,
  signal: AbortSignal,
) {
  const { entry } = await port.detail(bookmark.fileId, signal);
  signal.throwIfAborted();
  const { choice, web } = readerApplications(
    policy,
    entry,
    fileApplicationDevice(window.innerWidth),
  );
  const id = bookmark.application === musicApplication ? 'audio' : bookmark.application;
  const application =
    choice.options.find((option) => option === id) ?? web.find((option) => option.id === id);
  if (entry.kind !== 'file' || entry.trashedAt !== null) throw new FilesError('missing');
  if (!application) throw new FilesError('unsupported');
  return { entry, application };
}

type ListPosition = { href: string; scrollTop: number; focusId?: string; departed: boolean };
type ReaderLocation = {
  pathname: string;
  href: string;
  target: ReaderBookmark | undefined;
  navigate: (href: string, replace?: boolean) => void;
};

export function ReaderWorkspace({
  children,
  pathname,
  href,
  target,
  navigate,
}: ReaderLocation & { children: ReactNode }) {
  const { t } = useFrontendTranslation();
  const failureText = useCallback(
    (error: unknown) =>
      error instanceof FilesError && (error.code === 'forbidden' || error.code === 'missing')
        ? t(`files.errors.${error.code}`)
        : t('files.viewer.unavailable'),
    [t],
  );
  const port = useFiles();
  const persistence = useReaderPersistence();
  const music = useFileMusic();
  const [, refresh] = useWorkspaceRevision();
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [mini, setMini] = useState<string>();
  const [front, setFront] = useState<'music' | 'video'>('music');
  const [mediaOpen, setMediaOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [resolution, setResolution] = useState<{ key: string; error: string }>();
  const [restored, setRestored] = useState(!persistence);
  const listPosition = useRef<ListPosition>(undefined);
  const closingRoute = useRef<string>(undefined);
  const restoringMini = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (pathname === '/home/view' && listPosition.current) listPosition.current.departed = true;
  }, [pathname]);
  const active = target ? readerKey(target) : undefined;
  useLayoutEffect(() => {
    if (closingRoute.current !== active) closingRoute.current = undefined;
  }, [active]);
  const activeFile = files.find((item) => readerKey(item.bookmark) === active);
  const activeSession = activeFile?.session;
  const foreground = pathname === '/home/view';
  const useMusic = music?.active !== undefined;
  const hasMiniVideo = mini !== undefined && mini !== active;
  const mediaFront = hasMiniVideo && (!useMusic || front === 'video') ? 'video' : 'music';

  useEffect(() => {
    if (!active || restoringMini.current !== active || active !== mini) return;
    restoringMini.current = undefined;
    const frame = requestAnimationFrame(() =>
      setMini((current) => (current === active ? undefined : current)),
    );
    return () => cancelAnimationFrame(frame);
  }, [active, mini]);

  const restoreAudio = useEffectEvent((entry: FileEntry, maxBytes: number, position: number) => {
    if (!music?.active) music?.restore(entry, maxBytes, position);
  });
  useEffect(() => {
    if (!persistence) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const bookmarks = await persistence.read();
        if (!bookmarks.length || signal.aborted) return;
        const policy = await port.readActiveFileApplications(signal);
        const media = bookmarks.some(
          (bookmark) => bookmark.application === musicApplication || bookmark.shelf === 'video',
        );
        const limits = media ? await readReaderLimits(port, signal) : undefined;
        const results = await Promise.all(
          bookmarks.slice(0, limit + 1).map(async (bookmark) => {
            try {
              const resolved = await checkBookmark(port, bookmark, policy, signal);
              const hasDraft =
                bookmark.application !== musicApplication &&
                (await persistence
                  .hasDraft(bookmark.fileId, bookmark.application)
                  .catch(() => false));
              return { bookmark, resolved, hasDraft };
            } catch (error) {
              return { bookmark, resolved: undefined, blocked: failureText(error) };
            }
          }),
        );
        if (signal.aborted) return;
        const recovered: OpenFile[] = [];
        for (const { bookmark, resolved, blocked, hasDraft } of results) {
          if (bookmark.application === musicApplication) {
            if (resolved && limits)
              restoreAudio(resolved.entry, limits.maxMediaBytes, bookmark.position ?? 0);
            continue;
          }
          const record: OpenFile = {
            bookmark,
            closeSequence: 0,
            draftState: hasDraft ? 'saved' : 'clean',
            ...(blocked ? { blocked } : {}),
          };
          if (resolved) {
            record.entry = resolved.entry;
            if (typeof resolved.application === 'object')
              record.applicationLabel = resolved.application.name;
            if (bookmark.shelf === 'video' && limits && bookmark.application === 'video') {
              const session = makeReaderSession(resolved.entry, resolved.application, limits);
              if (session) {
                record.session = session;
                setMini((current) => current ?? readerKey(bookmark));
              }
            }
          }
          recovered.push(record);
        }
        setFiles((current) =>
          [
            ...current,
            ...recovered.filter(
              (item) =>
                !current.some(
                  (existing) => readerKey(existing.bookmark) === readerKey(item.bookmark),
                ),
            ),
          ].slice(0, limit),
        );
      } catch {
        if (!signal.aborted) setMessage(t('files.viewer.workspaceFailure'));
      } finally {
        if (!signal.aborted) setRestored(true);
      }
    })();
    return () => controller.abort();
  }, [failureText, persistence, port, t]);

  const musicActive = music?.active;
  const storedBookmarks = JSON.stringify([
    ...files
      .filter((item) => item.entry?.trashedAt == null)
      .map(({ bookmark }) => ({
        fileId: bookmark.fileId,
        application: bookmark.application,
        ...(bookmark.position === undefined ? {} : { position: bookmark.position }),
        ...(hasMiniVideo && mini === readerKey(bookmark) ? { shelf: 'video' } : {}),
      })),
    ...(musicActive
      ? [
          {
            fileId: musicActive.fileId,
            application: musicApplication,
            position: musicActive.position,
          },
        ]
      : []),
  ]);
  useEffect(() => {
    if (!restored || !persistence) return;
    void persistence
      .write(JSON.parse(storedBookmarks) as ReaderBookmark[])
      .catch(() => setMessage(t('files.viewer.workspaceFailure')));
  }, [persistence, restored, storedBookmarks, t]);

  function rememberList(entryId?: string) {
    if (pathname !== '/home') return;
    const content = document.getElementById('main-content');
    const focused = document.activeElement;
    const focusId =
      focused instanceof HTMLElement && focused.id && content?.contains(focused)
        ? focused.id
        : entryId && document.getElementById('file-entry-' + entryId)?.id;
    listPosition.current = {
      href,
      departed: false,
      scrollTop: content?.scrollTop ?? 0,
      ...(focusId ? { focusId } : {}),
    };
  }

  function restoreListPosition(content: HTMLElement, ready: boolean) {
    const previous = listPosition.current;
    if (!previous?.departed || pathname !== '/home' || href !== previous.href || !ready) return;
    listPosition.current = undefined;
    content.scrollTop = previous.scrollTop;
    const focused = previous.focusId ? document.getElementById(previous.focusId) : undefined;
    (focused ?? content).focus({ preventScroll: true });
  }

  function show(bookmark: ReaderBookmark, replace = false, entryId?: string) {
    const key = readerKey(bookmark);
    if (active === key) return;
    rememberList(entryId);
    setMessage('');
    restoringMini.current = mini === key ? key : undefined;
    navigate(readerHref(bookmark), replace);
  }

  function returnToFiles() {
    if (!foreground) return;
    const parent = activeFile?.entry?.parentId;
    navigate(
      listPosition.current?.href ?? (parent ? `/home?${new URLSearchParams({ parent })}` : '/home'),
      true,
    );
  }

  function openReader(
    entry: FileEntry,
    application: string,
    session: OpenReaderSession,
    replacing?: string,
  ) {
    const bookmark = { fileId: entry.id, application };
    const key = readerKey(bookmark);
    const existing = files.find((item) => readerKey(item.bookmark) === key);
    if (!existing && !replacing && files.length >= limit) {
      setMessage(t('files.viewer.limit'));
      return;
    }
    if (replacing || !existing?.session)
      setFiles((current) => {
        const retained = replacing
          ? current.filter((item) => readerKey(item.bookmark) !== replacing)
          : current;
        if (retained.some((item) => readerKey(item.bookmark) === key && item.session))
          return retained;
        return [
          ...retained.filter((item) => readerKey(item.bookmark) !== key),
          {
            bookmark,
            entry,
            session,
            closeSequence: 0,
            draftState: 'clean',
            ...(session.kind === 'web' ? { applicationLabel: session.application.name } : {}),
          },
        ];
      });
    show(bookmark, Boolean(replacing), entry.id);
  }

  const patch = useCallback((key: string, update: (item: OpenFile) => OpenFile) => {
    setFiles((current) =>
      current.map((item) => (readerKey(item.bookmark) === key ? update(item) : item)),
    );
  }, []);

  const loadRoute = useEffectEvent(async (key: string, signal: AbortSignal) => {
    if (!target || readerKey(target) !== key || closingRoute.current === key) return;
    const existing = files.find((item) => readerKey(item.bookmark) === key);
    if (existing?.session) return;
    if (!existing && files.length >= limit) {
      setResolution({ key, error: t('files.viewer.limit') });
      return;
    }
    try {
      const [policy, limits] = await Promise.all([
        port.readActiveFileApplications(signal),
        readReaderLimits(port, signal),
      ]);
      const { entry, application } = await checkBookmark(port, target, policy, signal);
      const session = makeReaderSession(entry, application, limits, {
        ...(application === 'image' ? { album: { entries: [entry], index: 0 } } : {}),
      });
      if (!session) throw new FilesError('unsupported');
      const bookmark = existing?.bookmark ?? target;
      const resolved: OpenFile = {
        bookmark,
        entry,
        session,
        closeSequence: existing?.closeSequence ?? 0,
        draftState: 'clean',
      };
      if (typeof application === 'object') resolved.applicationLabel = application.name;
      setFiles((current) => {
        if (current.some((item) => readerKey(item.bookmark) === key))
          return current.map((item) =>
            readerKey(item.bookmark) === key && !item.session ? resolved : item,
          );
        return current.length < limit ? [...current, resolved] : current;
      });
      setResolution({ key, error: '' });
    } catch (error) {
      if (!signal.aborted) setResolution({ key, error: failureText(error) });
    }
  });

  useEffect(() => {
    if (!active || !restored || activeSession) return;
    const controller = new AbortController();
    const frame = requestAnimationFrame(() => void loadRoute(active, controller.signal));
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [active, activeSession, restored]);

  function finish(key: string) {
    setMessage('');
    setFiles((current) => current.filter((item) => readerKey(item.bookmark) !== key));
    setMini((value) => (value === key ? undefined : value));
    if (active === key) {
      closingRoute.current = key;
      returnToFiles();
    }
  }

  function requestClose(item: OpenFile) {
    const key = readerKey(item.bookmark);
    if (!item.session) finish(key);
    else {
      show(item.bookmark);
      patch(key, (current) => ({ ...current, closeSequence: current.closeSequence + 1 }));
    }
  }

  function moveImage(item: OpenFile, next: MediaReaderSession) {
    const bookmark = { fileId: next.entry.id, application: item.bookmark.application };
    if (readerKey(bookmark) === readerKey(item.bookmark)) return;
    setFiles((current) => {
      const exists = current.some((value) => readerKey(value.bookmark) === readerKey(bookmark));
      return current.flatMap((value) =>
        readerKey(value.bookmark) !== readerKey(item.bookmark)
          ? [value]
          : exists
            ? []
            : [{ ...value, bookmark, entry: next.entry, session: next }],
      );
    });
    show(bookmark, true);
  }

  return (
    <ReaderWorkspaceContext
      value={{
        foreground: Boolean(foreground && activeSession),
        openReader,
        dockOpen: mediaOpen && useMusic && mediaFront === 'music',
        toggleDock: () => {
          if (mediaOpen && mediaFront === 'music') setMediaOpen(false);
          else {
            setFront('music');
            setMediaOpen(true);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>('[data-reader-media-panel]')
                ?.focus({ preventScroll: true }),
            );
          }
        },
        startMusic: () => {
          setFront('music');
          setMediaOpen(false);
        },
        viewerPending: Boolean(target && !activeSession && resolution?.key !== active),
        viewerError: foreground && resolution?.key === active ? (resolution?.error ?? '') : '',
        returnToFiles,
        restoreListPosition,
      }}
    >
      {children}
      <MediaShelf
        music={music}
        video={hasMiniVideo}
        front={mediaFront}
        setFront={setFront}
        open={mediaOpen}
        setOpen={setMediaOpen}
      />
      {files.map((item) => {
        if (!item.session || !item.entry) return null;
        const entry = item.entry;
        const key = readerKey(item.bookmark);
        const presentation = active === key ? 'reader' : mini === key ? 'mini' : 'parked';
        return (
          <MountedReader
            key={key}
            item={item}
            session={item.session}
            entry={entry}
            presentation={presentation}
            miniVisible={mediaOpen && mediaFront === 'video'}
            persistence={persistence}
            patch={(update) => patch(key, update)}
            minimize={() => {
              if (isVideo(item)) {
                setMini(key);
                setFront('video');
                setMediaOpen(false);
              }
              returnToFiles();
            }}
            returnToFiles={returnToFiles}
            openFolder={() =>
              navigate(
                item.entry?.parentId
                  ? `/home?${new URLSearchParams({ parent: item.entry.parentId })}`
                  : '/home',
              )
            }
            restore={() => {
              setMediaOpen(false);
              show(item.bookmark);
            }}
            close={() => finish(key)}
            replaceWithBuiltIn={(application, session) =>
              openReader(entry, application, session, key)
            }
            onChanged={() => refresh((value) => value + 1)}
            onMoveImage={(next) => moveImage(item, next)}
            notify={setMessage}
          />
        );
      })}
      <ReaderDock
        files={files}
        onActivate={(item) => show(item.bookmark)}
        onClose={requestClose}
        active={active}
        message={message}
      />
    </ReaderWorkspaceContext>
  );
}

function MountedReader({
  item,
  session,
  entry,
  presentation,
  miniVisible,
  persistence,
  patch,
  minimize,
  returnToFiles,
  openFolder,
  restore,
  close,
  replaceWithBuiltIn,
  onChanged,
  onMoveImage,
  notify,
}: {
  item: OpenFile;
  session: OpenReaderSession;
  entry: FileEntry;
  presentation: ViewerPresentation;
  miniVisible: boolean;
  persistence: ReaderPersistence | undefined;
  patch: (update: (item: OpenFile) => OpenFile) => void;
  minimize: () => void;
  returnToFiles: () => void;
  openFolder: () => void;
  restore: () => void;
  close: () => void;
  replaceWithBuiltIn: (application: FileApplicationID, session: OpenReaderSession) => void;
  onChanged: () => void;
  onMoveImage: (next: MediaReaderSession) => void;
  notify: (message: string) => void;
}) {
  const port = useFiles();
  const { t } = useFrontendTranslation();
  const draft = useMemo(
    () => persistence?.draft(entry.id, item.bookmark.application),
    [entry.id, item.bookmark.application, persistence],
  );
  const closeInterceptor = useRef<() => void>(undefined);
  const interceptClose = useCallback((request: () => void) => {
    closeInterceptor.current = request;
    return () => {
      if (closeInterceptor.current === request) closeInterceptor.current = undefined;
    };
  }, []);
  const video = isVideo(item);
  const hidden = presentation === 'parked' || (presentation === 'mini' && !miniVisible);
  const download = (target = entry) => {
    void port
      .download(target)
      .catch((error: unknown) =>
        notify(t(`files.errors.${error instanceof FilesError ? error.code : 'unavailable'}`)),
      );
  };
  const updateMedia = (update: (media: MediaReaderSession) => MediaReaderSession) =>
    patch((current) => {
      if (current.session?.kind !== 'media') return current;
      const next = update(current.session);
      return { ...current, session: next, entry: next.entry };
    });
  return (
    <div
      hidden={hidden}
      inert={hidden}
      data-reader-presentation={presentation}
      {...(presentation === 'mini' && !hidden ? { 'data-reader-media-card': '' } : {})}
      className={
        presentation === 'reader'
          ? 'file-reader-stage fixed inset-x-0 top-0 z-overlay'
          : presentation === 'mini'
            ? 'file-reader-mini fixed inset-x-2 mx-auto max-w-5xl'
            : undefined
      }
    >
      <ReaderSurfaceContext
        value={{
          entry,
          presentation,
          video,
          closeSequence: item.closeSequence,
          minimize,
          returnToFiles,
          openFolder,
          restore,
          close,
          interceptClose,
          requestInterceptedClose() {
            if (!closeInterceptor.current) return false;
            closeInterceptor.current();
            return true;
          },
          download,
          draft,
          draftState: item.draftState,
          setDraftState: (draftState) =>
            patch((current) =>
              current.draftState === draftState ? current : { ...current, draftState },
            ),
        }}
      >
        <FileReader
          session={session}
          close={close}
          replaceWithBuiltIn={replaceWithBuiltIn}
          download={download}
          changed={onChanged}
          saved={onChanged}
          playback={
            video
              ? {
                  presentation,
                  ...(item.bookmark.position === undefined
                    ? {}
                    : { position: item.bookmark.position }),
                  onPosition(seconds) {
                    const position = Math.floor(seconds);
                    patch((current) =>
                      current.bookmark.position === position
                        ? current
                        : { ...current, bookmark: { ...current.bookmark, position } },
                    );
                  },
                }
              : undefined
          }
          moveImage={(delta) => {
            const current = session.kind === 'media' ? session : undefined;
            if (!current?.album) return;
            const index = current.album.index + delta;
            const target = current.album.entries[index];
            if (target)
              onMoveImage({
                ...current,
                entry: target,
                album: { ...current.album, index },
                savedImageVersion: false,
              });
          }}
          refreshPublishedImage={async (target, signal) => {
            const { entry: next } = await port.detail(target.id, signal);
            signal.throwIfAborted();
            if (next.contentRevision <= target.contentRevision || next.trashedAt !== null)
              throw new FilesError('conflict');
            updateMedia((current) =>
              current.entry.id !== target.id
                ? current
                : {
                    ...current,
                    entry: next,
                    savedImageVersion: true,
                    ...(current.album
                      ? {
                          album: {
                            ...current.album,
                            entries: current.album.entries.map((value) =>
                              value.id === next.id ? next : value,
                            ),
                          },
                        }
                      : {}),
                  },
            );
            onChanged();
          }}
        />
      </ReaderSurfaceContext>
    </div>
  );
}
