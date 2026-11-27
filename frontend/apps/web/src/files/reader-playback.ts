import { useLayoutEffect, type RefObject } from 'react';
import type { FileMediaProps, VideoPlaybackHandoff } from '@neocloud/surface/files/runtime';
import { useLockStore } from '../state/use-lock-store';

export function useReaderPlayback(
  node: RefObject<HTMLMediaElement | null>,
  playback: FileMediaProps['playback'],
) {
  const locked = useLockStore((state) => state.locked);
  const parked = playback?.presentation === 'parked';
  const managed = playback !== undefined;
  useLayoutEffect(() => {
    if (parked || (locked && managed)) node.current?.pause();
  }, [locked, node, parked, managed]);
}

export function applyReaderPosition(media: HTMLMediaElement, position: number | undefined) {
  if (position && Number.isFinite(media.duration))
    media.currentTime = Math.min(media.duration, position);
}

/** 每个 Files Runtime 只保留自己账户内明确交接的原生视频字节。 */
export type VideoHandoffBuffers = WeakMap<
  VideoPlaybackHandoff,
  Readonly<{ entry: FileMediaProps['entry']; blob: Blob }>
>;

export function captureVideoPlayback(
  media: HTMLMediaElement,
  preferences: Pick<VideoPlaybackHandoff, 'subtitle' | 'quality'>,
): VideoPlaybackHandoff {
  const state = {
    position: media.currentTime,
    volume: media.volume,
    muted: media.muted,
    playing: !media.paused && !media.ended,
    ...preferences,
  };
  media.pause();
  return state;
}

export function restoreVideoPlayback(
  media: HTMLMediaElement,
  state: VideoPlaybackHandoff | undefined,
  position: number | undefined,
) {
  if (!state) {
    applyReaderPosition(media, position);
    return;
  }
  media.volume = state.volume;
  media.muted = state.muted;
  if (media.seekable.length && !Number.isFinite(media.duration)) {
    const last = media.seekable.length - 1;
    media.currentTime = Math.max(
      media.seekable.start(last),
      Math.min(media.seekable.end(last), state.position),
    );
  } else {
    applyReaderPosition(media, state.position);
  }
  if (state.playing && !useLockStore.getState().locked) void media.play().catch(() => undefined);
}

/** 由账号 Web Runtime 显式持有，只协调当前工作区中的有声播放。 */
export function createReaderAudioFocus() {
  let current: HTMLMediaElement | undefined;
  return (media: HTMLMediaElement) => {
    if (media.muted || media.volume === 0 || media.paused) return;
    if (current !== media && current?.isConnected && !current.muted && current.volume > 0)
      current.pause();
    current = media;
  };
}
