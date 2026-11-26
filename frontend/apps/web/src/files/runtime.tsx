'use client';
import { lazy, Suspense } from 'react';
import type { FileDocumentProps, FileEntry } from '@clouddrive/surface/files';
import { useFrontendTranslation } from '@clouddrive/i18n';
import {
  FilesProvider,
  type FileMediaProps,
  type ReaderDraft,
} from '@clouddrive/surface/files/runtime';
import { Page, PageHeader } from '@clouddrive/surface-foundation/layout';
import { StateSurface } from '@clouddrive/ui-adapter/state-surface';
import { Action } from '@clouddrive/ui-adapter/action';
import { Cloud, Image as ImageIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSiteProfile } from '@clouddrive/surface/administration/runtime';
import { readAuthConfig } from '../auth/config';
import { AuthContext, useAuth } from '../auth/context';
import { FileAccountMenu } from './account-menu';
import { createFilesRuntime, fileDestinationHrefs } from './backend';
import { fileDestinationHref } from './destinations';
import { FileMediaView, type ImageToolsProps, type VideoToolsProps } from './media-view';
import type { MusicRequest } from './music-player';
import { createReaderPersistence } from './reader-persistence';
import { downloadBlob } from './native-download';
import { createReaderAudioFocus, type VideoHandoffBuffers } from './reader-playback';
import { MusicDock } from './music-dock';

const PDFReader = lazy(() =>
  import('./pdf/reader-view').then((module) => ({ default: module.PDFReaderView })),
);
const VideoSubtitles = lazy(() =>
  import('./video-subtitles').then((module) => ({ default: module.VideoSubtitles })),
);
const HlsPlayer = lazy(() =>
  import('./hls-player').then((module) => ({ default: module.HlsPlayer })),
);
const ImageEditor = lazy(() =>
  import('./image-editor').then((module) => ({ default: module.ImageEditor })),
);
const MusicPlayer = lazy(() =>
  import('./music-player').then((module) => ({ default: module.MusicPlayer })),
);
export function FilesRuntime({
  children,
  fileWorkspace,
}: Readonly<{ children: ReactNode; fileWorkspace: boolean }>) {
  const { t } = useFrontendTranslation();
  const controller = useContext(AuthContext);
  const account = useAuth().session?.user.id;
  const router = useRouter();
  const [routing] = useState(() => {
    let push = router.push.bind(router);
    return {
      bind(next: typeof push) {
        push = next;
      },
      navigate(href: string) {
        push(href);
      },
    };
  });
  useLayoutEffect(() => {
    routing.bind(router.push.bind(router));
  }, [router, routing]);
  const { profile } = useSiteProfile();
  const addresses = profile?.siteAddresses;
  const [transferFailure, setTransferFailure] = useState(false);
  const runtime = useMemo(() => {
    const config = readAuthConfig();
    if (config.mode !== 'backend' || !account) return null;
    return createFilesRuntime(
      config.apiBaseUrl,
      () => controller?.getState().session?.user.id ?? null,
      (destination, query) => routing.navigate(fileDestinationHref(destination, query)),
      (parent) =>
        routing.navigate(
          fileDestinationHrefs.files +
            (parent ? '?' + new URLSearchParams({ parent }).toString() : ''),
        ),
    );
  }, [controller, account, routing]);
  const filePort = useMemo(
    () => runtime && (addresses ? runtime.withSiteAddresses(addresses) : runtime),
    [runtime, addresses],
  );
  const musicSequence = useRef(0);
  const readerPersistence = useMemo(
    () => (account ? createReaderPersistence(account) : undefined),
    [account],
  );
  const claimAudio = useMemo(() => runtime && createReaderAudioFocus(), [runtime]);
  const [musicRequest, setMusicRequest] = useState<{
    runtime: NonNullable<typeof runtime>;
    sequence: number;
    playback: MusicRequest;
    active: { fileId: string; position: number };
  }>();
  useEffect(() => {
    if (fileWorkspace) return;
    const frame = requestAnimationFrame(() => setMusicRequest(undefined));
    return () => cancelAnimationFrame(frame);
  }, [fileWorkspace]);
  const playAudio = useCallback(
    (entry: FileEntry, maxBytes: number, position?: number) => {
      if (!runtime) return;
      let consumed = position !== undefined;
      setMusicRequest({
        runtime,
        sequence: ++musicSequence.current,
        active: { fileId: entry.id, position: position ?? 0 },
        playback: {
          entry,
          maxBytes,
          ...(position === undefined ? {} : { position }),
          consumeAutoplay: () => {
            if (consumed) return false;
            consumed = true;
            return true;
          },
        },
      });
    },
    [runtime],
  );
  const Media = useMemo(() => {
    if (!runtime || !claimAudio) return undefined;
    const { readMedia, subtitles, queueImageCopy, publishImageVersion, openPrivateHls } = runtime;
    const retainedVideo: VideoHandoffBuffers = new WeakMap();
    function VideoTools({
      entry,
      media,
      presentation,
      initialChoice,
      onChoiceChange,
    }: VideoToolsProps) {
      return (
        <Suspense>
          <VideoSubtitles
            key={entry.id + ':' + entry.contentRevision}
            source={subtitles}
            entry={entry}
            media={media}
            {...(presentation ? { presentation } : {})}
            {...(initialChoice === undefined ? {} : { initialChoice })}
            {...(onChoiceChange ? { onChoiceChange } : {})}
          />
        </Suspense>
      );
    }
    function ImageTools(props: ImageToolsProps) {
      const { t } = useFrontendTranslation();
      const [open, setOpen] = useState(Boolean(props.editing.openOnMount && !props.editing.draft));
      const [stored, setStored] = useState<ReaderDraft>();
      const [failed, setFailed] = useState(false);
      const exportRequest = useRef<AbortController | null>(null);
      const disk = props.editing.draft;
      const openOnMount = props.editing.openOnMount;
      const revision = props.editing.entry.contentRevision;
      const conflict = stored && stored.revision !== revision ? stored : undefined;
      useEffect(() => {
        let active = true;
        void disk
          ?.read()
          .then((draft) => {
            if (!active) return;
            setStored(draft);
            if (draft?.revision === revision || openOnMount) setOpen(true);
          })
          .catch(() => {
            if (!active) return;
            setFailed(true);
            if (openOnMount) setOpen(true);
          });
        return () => {
          active = false;
          exportRequest.current?.abort();
        };
      }, [disk, revision, openOnMount]);
      const label = t('files.editImage');
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Action
            size="sm"
            variant="secondary"
            leadingIcon={<ImageIcon />}
            onPress={() => setOpen(true)}
          >
            {label}
          </Action>
          {conflict ? (
            <>
              <p role="status">{t('files.viewer.draftConflict')}</p>
              <Action
                size="sm"
                variant="secondary"
                onPress={() => {
                  exportRequest.current?.abort();
                  const controller = new AbortController();
                  exportRequest.current = controller;
                  void import('./image-reader-draft')
                    .then(({ exportImageDraft }) =>
                      exportImageDraft(conflict.payload, props.maxBytes, controller.signal),
                    )
                    .then((file) => {
                      if (!controller.signal.aborted)
                        downloadBlob(file, props.editing.entry.name + '.draft.png');
                    })
                    .catch(() => {
                      if (!controller.signal.aborted) setFailed(true);
                    });
                }}
              >
                {t('files.viewer.downloadDraft')}
              </Action>
            </>
          ) : null}
          {failed ? <p role="alert">{t('files.viewer.draftFailure')}</p> : null}
          {open ? (
            <Suspense fallback={<p role="status">{t('files.mediaLoading')}</p>}>
              <ImageEditor
                {...props}
                queueCopy={queueImageCopy}
                publishVersion={publishImageVersion}
                initialDraft={stored?.revision === revision ? stored : undefined}
                onClose={(keepDraft) => {
                  if (!keepDraft) setStored(undefined);
                  setOpen(false);
                  if (keepDraft)
                    void disk
                      ?.read()
                      .then(setStored)
                      .catch(() => setFailed(true));
                }}
              />
            </Suspense>
          ) : null}
        </div>
      );
    }
    return function MediaRenderer(props: FileMediaProps) {
      if (props.videoPlaylist && props.mode === 'preview' && props.version === undefined) {
        return (
          <Suspense fallback={<p role="status">{props.entry.name}</p>}>
            <HlsPlayer
              {...props}
              open={openPrivateHls}
              videoTools={VideoTools}
              claimAudio={claimAudio}
              onDownload={props.videoPlaylist.download}
            />
          </Suspense>
        );
      }
      return props.mode === 'preview' && props.version === undefined ? (
        <FileMediaView
          {...props}
          readContent={readMedia}
          retainedVideo={retainedVideo}
          videoTools={VideoTools}
          claimAudio={claimAudio}
          {...(props.imageEditing ? { imageTools: ImageTools } : {})}
        />
      ) : (
        <FileMediaView {...props} readContent={readMedia} />
      );
    };
  }, [claimAudio, runtime]);
  const Document = useMemo(
    () =>
      runtime
        ? function DocumentRenderer(props: FileDocumentProps) {
            return (
              <Suspense fallback={<p role="status">{props.entry.name}</p>}>
                <PDFReader {...props} readContent={runtime.readDocument} />
              </Suspense>
            );
          }
        : undefined,
    [runtime],
  );
  useLayoutEffect(() => {
    if (!runtime) return;
    runtime.activate();
    return () => {
      void runtime.dispose().catch(() => setTransferFailure(true));
    };
  }, [runtime]);
  if (!runtime || !filePort || !Media || !Document || !claimAudio)
    return fileWorkspace ? (
      <main id="main-content" tabIndex={-1} className="p-4">
        <Page>
          <PageHeader
            title={t('common.filesWorkspaceTitle')}
            description={t('common.filesWorkspaceDescription')}
          />
          <StateSurface
            state="disabled"
            icon={<Cloud />}
            title={t('common.filesUnavailableTitle')}
            description={t('common.filesUnavailableDescription')}
          />
        </Page>
      </main>
    ) : (
      children
    );
  return (
    <FilesProvider
      key={account}
      port={filePort.port}
      archives={runtime.archives}
      media={Media}
      pdfReader={Document}
      mediaDock={MusicDock}
      accountTools={FileAccountMenu}
      {...(readerPersistence ? { readerPersistence } : {})}
      uploadMarkdownImage={runtime.uploadMarkdownImage}
      drawioEndpoint={
        process.env.NEXT_PUBLIC_CLOUDDRIVE_DRAWIO_URL ?? 'https://embed.diagrams.net/'
      }
      {...(fileWorkspace
        ? {
            music: {
              play: playAudio,
              restore: playAudio,
              ...(musicRequest?.runtime === runtime ? { active: musicRequest.active } : {}),
              render: (dock) =>
                musicRequest?.runtime === runtime ? (
                  <Suspense fallback={<p role="status">{t('files.mediaLoading')}</p>}>
                    <MusicPlayer
                      key={musicRequest.sequence}
                      request={musicRequest.playback}
                      dock={dock}
                      claimAudio={claimAudio}
                      listFiles={runtime.port.list}
                      readEntry={runtime.port.detail}
                      readMedia={runtime.readMedia}
                      onPosition={(fileId, position) =>
                        setMusicRequest((current) =>
                          current?.sequence === musicRequest.sequence &&
                          (current.active.fileId !== fileId || current.active.position !== position)
                            ? { ...current, active: { fileId, position } }
                            : current,
                        )
                      }
                      onStop={() =>
                        setMusicRequest((current) =>
                          current?.sequence === musicRequest.sequence ? undefined : current,
                        )
                      }
                    />
                  </Suspense>
                ) : null,
            },
          }
        : {})}
      transfers={runtime.transfers}
      connections={runtime.connections}
      downloads={runtime.downloads}
      navigation={filePort.navigation}
    >
      <div
        onDragOver={(event) => {
          if (fileWorkspace && event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!fileWorkspace || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          try {
            runtime.offer(Array.from(event.dataTransfer.files));
            setTransferFailure(false);
          } catch {
            setTransferFailure(true);
          }
        }}
        onPaste={(event) => {
          if (!fileWorkspace || !event.clipboardData?.files.length) return;
          if (
            event.target instanceof Element &&
            event.target.closest('input,textarea,[contenteditable="true"]')
          )
            return;
          event.preventDefault();
          try {
            runtime.offer(Array.from(event.clipboardData.files));
            setTransferFailure(false);
          } catch {
            setTransferFailure(true);
          }
        }}
      >
        {transferFailure ? (
          <p role="alert" className="p-4 text-danger">
            {t('common.fileTransferFailed')}
          </p>
        ) : null}
        {children}
      </div>
    </FilesProvider>
  );
}
