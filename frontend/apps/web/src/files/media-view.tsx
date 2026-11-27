'use client';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { FilesError, type FilesErrorCode } from '@clouddrive/surface/files';
import type { FileMediaProps, ImageEditingAccess } from '@clouddrive/surface/files/runtime';

import { rasterType } from './media-signatures';
import type { ImageSize } from './image-edit';
import { editableImageType } from './image-format';
import { audioMediaType } from './audio-format';
import {
  captureVideoPlayback,
  restoreVideoPlayback,
  useReaderPlayback,
  type VideoHandoffBuffers,
} from './reader-playback';
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const ImageViewer = lazy(() => import('./image-viewer'));

export type VideoToolsProps = Readonly<{
  entry: FileMediaProps['entry'];
  media: RefObject<HTMLMediaElement | null>;
  presentation?: 'toolbar';
  initialChoice?: string;
  onChoiceChange?: (choice: string) => void;
}>;

export type ImageToolsProps = Readonly<{
  editing: ImageEditingAccess;
  source: Blob;
  size: ImageSize;
  maxBytes: number;
}>;

/** FileMediaView 拥有媒体 URL、请求和播放器关闭，不向 Surface 传递浏览器句柄。 */
export function FileMediaView({
  entry,
  mode,
  alt,
  maxBytes,
  readContent,
  version,
  playback,
  claimAudio,
  labels,
  imageEditing,
  presentation,
  resumeVideo,
  registerVideoHandoff,
  onReady,
  onFailure,
  retainedVideo,
  videoTools: VideoTools,
  imageTools: ImageTools,
}: FileMediaProps &
  Readonly<{
    readContent: (
      id: string,
      expectedSizeBytes: number,
      signal: AbortSignal,
      version?: number,
    ) => Promise<Blob>;
    videoTools?: ComponentType<VideoToolsProps>;
    imageTools?: ComponentType<ImageToolsProps>;
    claimAudio?: (media: HTMLMediaElement) => void;
    retainedVideo?: VideoHandoffBuffers;
  }>) {
  const { t } = useFrontendTranslation();
  const [result, setResult] = useState<
    Readonly<{
      key: string;
      reader: typeof readContent;
      url: string;
      failure: FilesErrorCode | '';
      failureCause?: unknown;
      imageSource?: Blob;
      videoSource?: Blob;
    }>
  >();
  const [naturalSize, setNaturalSize] = useState<{ url: string; size: ImageSize }>();
  const [videoReady, setVideoReady] = useState('');
  const [attempt, setAttempt] = useState(0);
  const quick = presentation === 'quick';
  const imageWorkspace =
    mode === 'preview' && version === undefined && (Boolean(imageEditing) || quick);
  const videoSourceAllowed = registerVideoHandoff !== undefined;
  const requestKey = JSON.stringify([
    entry.id,
    entry.contentRevision,
    entry.sizeBytes,
    entry.mediaType,
    mode,
    maxBytes,
    version,
    attempt,
  ]);
  const current = result?.key === requestKey && result.reader === readContent ? result : undefined;
  const url = current?.url ?? '';
  const failureCode = current?.failure;
  const failureCause = current?.failureCause;
  useEffect(() => {
    if (failureCode) onFailure?.(new FilesError(failureCode, { cause: failureCause }));
  }, [failureCode, failureCause, onFailure]);
  const media = useRef<HTMLMediaElement | null>(null);
  const resume = useRef(resumeVideo);
  const subtitle = useRef(resumeVideo?.subtitle);
  useReaderPlayback(media, playback);
  // ref 可能先解绑，StrictMode 也会模拟解绑；保留最后的自有节点，交给 effect 真正释放。
  const attachMedia = useCallback((node: HTMLMediaElement | null) => {
    if (node) media.current = node;
  }, []);
  useEffect(() => {
    if (!registerVideoHandoff) return;
    registerVideoHandoff(() => {
      const player = media.current;
      if (!player) return undefined;
      const choice = subtitle.current;
      const state = captureVideoPlayback(player, choice === undefined ? {} : { subtitle: choice });
      if (current?.videoSource) retainedVideo?.set(state, { entry, blob: current.videoSource });
      return state;
    });
    return () => registerVideoHandoff(undefined);
  }, [registerVideoHandoff, current?.videoSource, entry, retainedVideo]);
  useEffect(() => {
    const controller = new AbortController();
    let ownedURL = '';
    void (async () => {
      try {
        if (entry.sizeBytes > maxBytes) throw new FilesError('large');
        const rawType = entry.mediaType.split(';')[0]?.toLowerCase() ?? '';
        const audioType = audioMediaType(rawType);
        const type = audioType ?? rawType;
        const image = type.startsWith('image/');
        if (!image && (mode !== 'preview' || (!audioType && !videoTypes.has(type))))
          throw new FilesError('unsupported');
        if (!image) {
          const probe = document.createElement(videoTypes.has(type) ? 'video' : 'audio');
          if (!probe.canPlayType(type)) throw new FilesError('unsupported');
        }
        const held = resumeVideo && retainedVideo?.get(resumeVideo);
        const reused =
          held &&
          held.entry.id === entry.id &&
          held.entry.contentRevision === entry.contentRevision &&
          held.entry.mediaType === entry.mediaType &&
          held.blob.size === entry.sizeBytes
            ? held.blob
            : undefined;
        const blob =
          reused ?? (await readContent(entry.id, entry.sizeBytes, controller.signal, version));
        if (blob.size > maxBytes) throw new FilesError('large');
        const safeType = image ? await rasterType(blob) : type;
        if (!safeType) throw new FilesError('unsupported');
        if (controller.signal.aborted) return;
        const safeBlob = reused ?? new Blob([blob], { type: safeType });
        ownedURL = URL.createObjectURL(safeBlob);
        setResult({
          key: requestKey,
          reader: readContent,
          url: ownedURL,
          failure: '',
          ...(image && imageWorkspace ? { imageSource: safeBlob } : {}),
          ...(videoSourceAllowed && videoTypes.has(type) ? { videoSource: safeBlob } : {}),
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            reader: readContent,
            url: '',
            failure: error instanceof FilesError ? error.code : 'unavailable',
            failureCause: error,
          });
      }
    })();
    return () => {
      controller.abort();
      const player = media.current;
      if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
      media.current = null;
      if (ownedURL) URL.revokeObjectURL(ownedURL);
    };
  }, [
    entry.id,
    entry.contentRevision,
    version,
    entry.sizeBytes,
    entry.mediaType,
    maxBytes,
    mode,
    readContent,
    requestKey,
    imageWorkspace,
    videoSourceAllowed,
    resumeVideo,
    retainedVideo,
  ]);
  if (current?.failure) {
    const failure =
      current.failure === 'large'
        ? (labels?.tooLarge ?? t('files.mediaTooLarge'))
        : current.failure === 'unsupported'
          ? (labels?.unsupported ?? t('files.mediaUnsupported'))
          : t('files.errors.' + current.failure);
    if (mode === 'inline') return <span title={failure}>{alt || entry.name}</span>;
    return (
      <div className="space-y-2 text-xs text-ink-muted">
        <p role="status">{failure}</p>
        <Action
          size="sm"
          variant="quiet"
          onPress={() => {
            setAttempt((value) => value + 1);
          }}
        >
          {labels?.retry ?? t('files.retry')}
        </Action>
      </div>
    );
  }
  if (!url) {
    if (mode === 'inline') return <span role="status">{alt || entry.name}</span>;
    return (
      <div className={quick ? 'grid min-h-0 flex-1 place-items-center' : undefined}>
        <p role="status" className="text-xs text-ink-muted">
          {labels?.loading ?? t('files.mediaLoading')}
        </p>
      </div>
    );
  }
  if (entry.mediaType.startsWith('image/')) {
    const source = current?.imageSource;
    const size = naturalSize?.url === url ? naturalSize.size : undefined;
    const picture = (
      <img
        src={url}
        alt={alt ?? entry.name}
        style={
          quick
            ? { width: '100%', height: '100%', objectFit: 'contain' }
            : source
              ? { maxHeight: '100%' }
              : mode === 'inline'
                ? { maxWidth: '100%', maxHeight: 'min(28rem, 60vh)', objectFit: 'contain' }
                : undefined
        }
        className={
          mode === 'thumbnail'
            ? 'h-40 w-full rounded-control object-contain'
            : mode === 'preview'
              ? 'max-h-screen w-full object-contain'
              : undefined
        }
        onLoad={
          source
            ? ({ currentTarget }) => {
                setNaturalSize({
                  url,
                  size: {
                    width: currentTarget.naturalWidth,
                    height: currentTarget.naturalHeight,
                  },
                });
                onReady?.();
              }
            : undefined
        }
        onError={() =>
          setResult({ key: requestKey, reader: readContent, url: '', failure: 'unsupported' })
        }
      />
    );
    if (!source) return picture;
    const editor =
      ImageTools && imageEditing && size && editableImageType(source.type) ? (
        <ImageTools editing={imageEditing} source={source} size={size} maxBytes={maxBytes} />
      ) : null;
    return (
      <Suspense fallback={<p role="status">{labels?.loading ?? t('files.mediaLoading')}</p>}>
        <ImageViewer
          key={url}
          source={source}
          {...(size ? { size } : {})}
          editor={editor}
          quick={quick}
        >
          {picture}
        </ImageViewer>
      </Suspense>
    );
  }
  if (entry.mediaType.startsWith('video/'))
    return (
      <>
        {VideoTools ? (
          <div hidden={playback?.presentation === 'mini'}>
            <VideoTools
              entry={entry}
              media={media}
              {...(quick ? { presentation: 'toolbar' as const } : {})}
              {...(resumeVideo?.subtitle === undefined
                ? {}
                : { initialChoice: resumeVideo.subtitle })}
              onChoiceChange={(choice) => {
                subtitle.current = choice;
              }}
            />
          </div>
        ) : null}
        <div className={quick ? 'relative min-h-0 flex-1' : 'contents'}>
          {quick && videoReady !== url ? (
            <p
              role="status"
              className="absolute inset-0 grid place-items-center text-sm text-ink-muted"
            >
              {labels?.loading ?? t('files.mediaLoading')}
            </p>
          ) : null}
          {/* 本人视频按需通过 TextTrack 接入字幕，其他原始媒体沿用原生控制。 */}
          {/* eslint-disable-next-line jsx-a11y-x/media-has-caption */}
          <video
            ref={attachMedia}
            controls
            playsInline
            preload="metadata"
            src={url}
            aria-label={entry.name}
            className={
              quick
                ? 'absolute inset-0 m-auto max-h-full max-w-full rounded-control object-contain'
                : 'min-h-0 max-h-full w-full flex-1 object-contain'
            }
            style={
              quick
                ? { visibility: videoReady === url ? 'visible' : 'hidden' }
                : VideoTools
                  ? { minHeight: 0, backgroundColor: 'black' }
                  : undefined
            }
            onLoadedMetadata={(event) => {
              setVideoReady(url);
              if (resume.current) retainedVideo?.delete(resume.current);
              restoreVideoPlayback(event.currentTarget, resume.current, playback?.position);
              resume.current = undefined;
            }}
            onLoadedData={() => onReady?.()}
            onTimeUpdate={(event) => playback?.onPosition?.(event.currentTarget.currentTime)}
            onPlay={(event) => claimAudio?.(event.currentTarget)}
            onVolumeChange={(event) => claimAudio?.(event.currentTarget)}
            onError={() =>
              setResult({ key: requestKey, reader: readContent, url: '', failure: 'unsupported' })
            }
          />
        </div>
      </>
    );
  return (
    // eslint-disable-next-line jsx-a11y-x/media-has-caption -- 原始上传媒体没有配套字幕；不伪造字幕，保留浏览器原生控制。
    <audio
      ref={attachMedia}
      controls
      preload="metadata"
      src={url}
      aria-label={entry.name}
      className="w-full"
      onError={() =>
        setResult({ key: requestKey, reader: readContent, url: '', failure: 'unsupported' })
      }
    />
  );
}
