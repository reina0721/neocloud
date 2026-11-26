'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  fileApplicationDevice,
  type FileApplicationPolicy,
} from '../../../src/files/file-applications';
import { FilesError, type FileEntry } from '../../../src/files/model';
import { useFiles } from '../../../src/files/runtime';
import {
  compatibleFileApplications,
  defaultReaderApplication,
  makeReaderSession,
  readerApplications,
  readReaderLimits,
  type OpenReaderSession,
  type ReaderApplication,
  type ReaderLimits,
} from './file-reader-session';

export type PreviewRoute = {
  fileId: string | undefined;
  listHref: string;
  isCurrent: () => boolean;
  show: (fileId: string, replace: boolean) => void;
  close: (owned: boolean) => void;
};

function isQuickApplication(application: ReaderApplication | undefined) {
  return (
    application === 'text' ||
    application === 'markdown' ||
    application === 'pdf' ||
    application === 'image' ||
    application === 'video'
  );
}

export function canOpenQuickPreview(entry: FileEntry) {
  return (
    entry.kind === 'file' &&
    entry.trashedAt === null &&
    compatibleFileApplications(entry, true).some(isQuickApplication)
  );
}

type QuickApplication = 'text' | 'markdown' | 'pdf' | 'image' | 'video';
type PreviewInput = {
  fileId: string;
  entry?: FileEntry | undefined;
  fromRoute?: boolean;
  neighbor?: boolean;
};
export type PreviewHistory = { owned: boolean; sourceFileId: string };
export type PreviewState = {
  id: number;
  input: PreviewInput;
  signal: AbortSignal;
  open: boolean;
  entry?: FileEntry | undefined;
  application?: QuickApplication;
  session?: OpenReaderSession;
  error?: unknown;
  contentReady?: boolean;
  textEditable?: boolean | undefined;
};

export function useQuickFilePreview({
  route,
  entries,
  limits,
  enabled,
  onOtherApplication,
}: {
  route: PreviewRoute;
  entries: readonly FileEntry[];
  limits: ReaderLimits;
  enabled: boolean;
  onOtherApplication: (entry: FileEntry, policy: FileApplicationPolicy) => void;
}) {
  const port = useFiles();
  const [preview, setPreview] = useState<PreviewState>();
  const [neighbors, setNeighbors] = useState<readonly FileEntry[]>([]);
  const request = useRef<AbortController>(undefined);
  const current = useRef<PreviewState>(undefined);
  const sequence = useRef(0);
  const origin = useRef<{ fileId: string; listHref: string }>(undefined);
  const page = useRef<readonly FileEntry[]>([]);
  const ownedHistory = useRef<{ listHref: string; sourceFileId: string; currentFileId: string }>(
    undefined,
  );
  const routeRequest = useRef<string>(undefined);
  const afterExit = useRef<(() => void) | undefined>(undefined);

  function update(next: PreviewState) {
    current.current = next;
    setPreview(next);
  }

  function focusOrigin() {
    const targetId = origin.current?.fileId;
    origin.current = undefined;
    requestAnimationFrame(() => {
      if (current.current?.open) return;
      const target = targetId && document.getElementById('file-entry-' + targetId);
      const fallback = document.getElementById('main-content');
      (target instanceof HTMLElement && target.getClientRects().length ? target : fallback)?.focus({
        preventScroll: true,
      });
    });
  }

  function dismiss(navigate: boolean, follow?: () => void) {
    const frame = current.current;
    if (!frame?.open) return;
    request.current?.abort();
    const activeFileId = routeRequest.current ?? route.fileId;
    if (navigate && activeFileId) {
      route.close(ownsHistory(activeFileId));
    }
    routeRequest.current = undefined;
    afterExit.current = follow ?? focusOrigin;
    update({ ...frame, open: false });
  }

  function ownsHistory(fileId: string | undefined) {
    const owned = ownedHistory.current;
    return owned?.listHref === route.listHref && owned.currentFileId === fileId;
  }

  function onExited() {
    if (current.current?.open) return;
    const complete = afterExit.current;
    afterExit.current = undefined;
    current.current = undefined;
    setPreview(undefined);
    complete?.();
  }

  function isCurrent(id: number) {
    return current.current?.id === id && current.current.open && !request.current?.signal.aborted;
  }

  async function begin(input: PreviewInput) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const signal = controller.signal;
    const frame = {
      id: ++sequence.current,
      input,
      entry: input.entry,
      open: true,
      signal,
    };
    update(frame);
    try {
      const [detail, policy, budgets] = await Promise.all([
        port.detail(input.fileId, signal),
        port.readActiveFileApplications(signal),
        limits.maxTextBytes === undefined || limits.maxMediaBytes === undefined
          ? readReaderLimits(port, signal)
          : limits,
      ]);
      if (!isCurrent(frame.id)) return;
      const { entry } = detail;
      if (entry.trashedAt !== null || entry.kind !== 'file') throw new FilesError('missing');
      const device = fileApplicationDevice(window.innerWidth);
      const selected = defaultReaderApplication(readerApplications(policy, entry, device));
      if (!isQuickApplication(selected)) {
        if (input.fromRoute || input.neighbor) throw new FilesError('unsupported');
        dismiss(false, () => onOtherApplication(entry, policy));
        return;
      }
      if (typeof selected !== 'string') throw new FilesError('unsupported');
      const session = makeReaderSession(entry, selected, budgets);
      if (!session) throw new FilesError('unsupported');
      if (!input.neighbor) {
        setNeighbors(
          page.current.filter(
            (item) =>
              canOpenQuickPreview(item) &&
              isQuickApplication(
                defaultReaderApplication(readerApplications(policy, item, device)),
              ),
          ),
        );
      }
      if (!input.fromRoute) {
        const replace = input.neighbor || Boolean(route.fileId || routeRequest.current);
        if (!replace)
          ownedHistory.current = {
            listHref: route.listHref,
            sourceFileId: origin.current?.fileId ?? input.fileId,
            currentFileId: input.fileId,
          };
        routeRequest.current = input.fileId;
        route.show(input.fileId, replace);
      }
      update({
        ...frame,
        entry,
        application: selected,
        session,
        textEditable: detail.textEditable,
      });
    } catch (error) {
      if (isCurrent(frame.id)) update({ ...frame, error });
    }
  }

  function open(entry: FileEntry) {
    if (!current.current?.open) {
      afterExit.current = undefined;
      origin.current = { fileId: entry.id, listHref: route.listHref };
      page.current = entries;
      setNeighbors([]);
    }
    void begin({ fileId: entry.id, entry });
  }

  const syncRoute = useEffectEvent(() => {
    if (!route.isCurrent()) return;
    if (origin.current && origin.current.listHref !== route.listHref) {
      ownedHistory.current = undefined;
      dismiss(false);
      origin.current = undefined;
    }
    if (route.fileId && enabled) {
      if (routeRequest.current === route.fileId) routeRequest.current = undefined;
      if (
        current.current?.input.fileId === route.fileId &&
        current.current.open &&
        !current.current.signal.aborted
      )
        return;
      if (current.current && !current.current.open && afterExit.current) return;
      if (!origin.current) {
        const sourceFileId =
          (ownsHistory(route.fileId) && ownedHistory.current?.sourceFileId) || route.fileId;
        origin.current = { fileId: sourceFileId, listHref: route.listHref };
        page.current = entries;
        setNeighbors([]);
      }
      void begin({
        fileId: route.fileId,
        entry: entries.find((entry) => entry.id === route.fileId),
        fromRoute: true,
      });
    } else if (current.current?.open && !routeRequest.current) {
      dismiss(false);
    }
  });

  useEffect(() => syncRoute(), [enabled, port, route.fileId, route.listHref]);
  useEffect(() => () => request.current?.abort(), [port]);

  const index = preview ? neighbors.findIndex((item) => item.id === preview.input.fileId) : -1;
  const previous = index > 0 ? neighbors[index - 1] : undefined;
  const next = index >= 0 ? neighbors[index + 1] : undefined;
  return {
    preview,
    open,
    close: () => dismiss(true),
    onExited,
    canPrevious: Boolean(previous),
    canNext: Boolean(next),
    move(direction: -1 | 1) {
      const target = direction === -1 ? previous : next;
      if (target) {
        if (ownedHistory.current && ownsHistory(routeRequest.current ?? route.fileId))
          ownedHistory.current.currentFileId = target.id;
        routeRequest.current = target.id;
        route.show(target.id, true);
        void begin({ fileId: target.id, entry: target, neighbor: true, fromRoute: true });
      }
    },
    retry: () => {
      const frame = current.current;
      if (frame?.open)
        void begin({
          ...frame.input,
          ...(route.fileId === frame.input.fileId ? { fromRoute: true } : {}),
        });
    },
    ready(id: number, detail?: { entry: FileEntry; textEditable?: boolean }) {
      const frame = current.current;
      if (frame && isCurrent(id)) update({ ...frame, contentReady: true, ...(detail ?? {}) });
    },
    fail(id: number, error: unknown) {
      const frame = current.current;
      if (frame && isCurrent(id)) update({ ...frame, error });
    },
    promote(action: (history: PreviewHistory) => void) {
      const frame = current.current;
      if (!frame?.open) return;
      const history = {
        owned: ownsHistory(routeRequest.current ?? route.fileId),
        sourceFileId: origin.current?.fileId ?? frame.input.fileId,
      };
      dismiss(false, () => action(history));
    },
  };
}
