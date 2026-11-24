import { useLayoutEffect, type RefObject } from 'react';
import type { FileMediaProps } from '@clouddrive/surface/files/runtime';
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
