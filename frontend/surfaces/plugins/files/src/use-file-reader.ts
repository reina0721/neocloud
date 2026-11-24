'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { FilesError, type FileEntry } from '../../../src/files/model';
import {
  fileApplicationDevice,
  type FileApplicationID,
  type FileApplicationPolicy,
  type WebFileApplicationItem,
} from '../../../src/files/file-applications';
import type { FileDocumentProps } from '../../../src/files/pdf-contract';
import { useFiles, useFileNavigation, usePlayFileAudio } from '../../../src/files/runtime';
import { isMarkdownFile } from '../../../src/files/markdown';
import {
  makeReaderSession,
  readerApplications,
  type FileApplicationPicker,
  type ReaderApplication,
} from './file-reader-session';
import { useReaderWorkspace } from './reader-workspace-context';

export function useFileReader({
  scope,
  entries,
  maxMediaBytes,
  maxTextBytes,
  pdfReaderLimits,
  onNotice,
}: {
  scope: string;
  entries: readonly FileEntry[];
  maxMediaBytes: number | undefined;
  maxTextBytes: number | undefined;
  pdfReaderLimits: FileDocumentProps['limits'] | undefined;
  onNotice: (message: string) => void;
}) {
  const port = useFiles();
  const navigation = useFileNavigation();
  const playAudio = usePlayFileAudio();
  const { openReader, startMusic } = useReaderWorkspace();
  const { t } = useFrontendTranslation();
  const pending = useRef<AbortController | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<FileApplicationPicker & { scope: string }>();
  const picker = snapshot?.scope === scope ? snapshot : undefined;
  useEffect(() => () => pending.current?.abort(), [scope]);
  const cancelPending = useCallback(() => {
    pending.current?.abort();
    setSnapshot(undefined);
  }, []);
  const errorText = useCallback(
    (error: unknown) =>
      t(`files.errors.${error instanceof FilesError ? error.code : 'unavailable'}`),
    [t],
  );
  const launch = useCallback(
    (
      entry: FileEntry,
      application: ReaderApplication,
      policy?: FileApplicationPolicy,
      plainEdit = false,
    ) => {
      setSnapshot(undefined);
      if (
        application === 'audio' &&
        playAudio &&
        maxMediaBytes !== undefined &&
        entry.trashedAt === null
      ) {
        playAudio(entry, maxMediaBytes);
        startMusic();
        return;
      }
      const device = fileApplicationDevice(window.innerWidth);
      const neighbors =
        application === 'image' && entry.trashedAt === null
          ? entries.filter(
              (item) =>
                item.kind === 'file' &&
                item.parentId === entry.parentId &&
                item.trashedAt === null &&
                item.sizeBytes <= (maxMediaBytes ?? 0) &&
                item.mediaType.startsWith('image/') &&
                (!policy ||
                  readerApplications(policy, item, device).choice.options.includes('image')),
            )
          : undefined;
      const index = neighbors?.findIndex((item) => item.id === entry.id) ?? -1;
      const album = neighbors
        ? index >= 0
          ? { entries: neighbors, index }
          : { entries: [entry], index: 0 }
        : undefined;
      const session = makeReaderSession(
        entry,
        application,
        {
          maxMediaBytes,
          maxTextBytes,
          pdfReader: pdfReaderLimits,
        },
        { plainEdit, ...(album ? { album } : {}) },
      );
      if (session)
        openReader(entry, typeof application === 'string' ? application : application.id, session);
      else onNotice(t('files.errors.unavailable'));
    },
    [
      entries,
      maxMediaBytes,
      maxTextBytes,
      onNotice,
      openReader,
      pdfReaderLimits,
      playAudio,
      t,
      startMusic,
    ],
  );
  const open = useCallback(
    async (entry: FileEntry, requested?: 'choose' | 'archive') => {
      cancelPending();
      if (entry.kind === 'shortcut') {
        navigation.openShortcut(entry.id);
        return;
      }
      if (entry.kind !== 'file') return;
      const controller = new AbortController();
      pending.current = controller;
      if (requested === 'choose') setSnapshot({ scope, entry });
      try {
        const policy = await port.readActiveFileApplications(controller.signal);
        if (controller.signal.aborted) return;
        const { choice, web } = readerApplications(
          policy,
          entry,
          fileApplicationDevice(window.innerWidth),
        );
        const webOptions = requested === 'archive' ? [] : web;
        const selectedWeb = requested
          ? undefined
          : (webOptions.find((app) => app.id === choice.defaultApp) ??
            (webOptions.length === 1 && choice.options.length === 0 ? webOptions[0] : undefined));
        const selected =
          requested === 'archive'
            ? choice.options.find((id) => id === requested)
            : requested === 'choose'
              ? undefined
              : webOptions.length
                ? choice.options.find((id) => id === choice.defaultApp)
                : choice.automatic;
        if (selectedWeb || selected) launch(entry, (selectedWeb ?? selected)!, policy);
        else
          setSnapshot({
            scope,
            entry,
            options: requested === 'archive' ? [] : choice.options,
            webOptions,
            policy,
          });
      } catch (error) {
        if (!controller.signal.aborted) setSnapshot({ scope, entry, error: errorText(error) });
      }
    },
    [cancelPending, errorText, launch, navigation, port, scope],
  );
  const download = useCallback(
    async (entry: FileEntry) => {
      try {
        await port.download(entry);
      } catch (error) {
        onNotice(errorText(error));
      }
    },
    [errorText, onNotice, port],
  );
  return {
    picker,
    open,
    download,
    cancelPending,
    edit(entry: FileEntry) {
      cancelPending();
      launch(entry, isMarkdownFile(entry) ? 'markdown' : 'text', undefined, true);
    },
    choose(application: FileApplicationID | WebFileApplicationItem) {
      if (picker && pending.current && !pending.current.signal.aborted)
        launch(picker.entry, application, picker.policy);
    },
  };
}
export type FileReaderController = ReturnType<typeof useFileReader>;
