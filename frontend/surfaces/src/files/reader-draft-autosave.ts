import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ReaderDraft, ReaderDraftHandle } from './reader-persistence';

export type ReaderDraftStatus = 'clean' | 'saving' | 'saved' | 'failed';

/** 草稿只确认最后一次完整落盘。关闭/放弃与在途写入共用顺序。 */
export function useReaderDraftAutosave({
  draft,
  dirty,
  change,
  capture,
  warning,
  onStatus,
  suspend = false,
}: {
  draft: ReaderDraftHandle | undefined;
  dirty: boolean;
  change: unknown;
  capture: (closing: boolean) => ReaderDraft | Promise<ReaderDraft>;
  warning: string;
  suspend?: boolean;
  onStatus?: ((status: ReaderDraftStatus) => void) | undefined;
}) {
  const [result, setResult] = useState<{ change: unknown; status: 'saved' | 'failed' }>();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  const wasDirty = useRef(false);
  const status = !dirty
    ? 'clean'
    : !draft
      ? 'failed'
      : result && Object.is(result.change, change)
        ? result.status
        : 'saving';

  async function saveNow(closing = false) {
    if (!draft) return false;
    const issued = generation.current;
    const task = queue.current.then(async () => {
      if (issued !== generation.current) return false;
      try {
        const record = await capture(closing);
        if (issued !== generation.current) return false;
        await draft.write(record);
        setResult({ change, status: 'saved' });
        return true;
      } catch {
        setResult({ change, status: 'failed' });
        return false;
      }
    });
    queue.current = task;
    return task;
  }

  async function clear() {
    generation.current += 1;
    const task = queue.current.then(() => draft?.clear());
    queue.current = task.catch(() => undefined);
    try {
      await task;
      setResult(undefined);
      return true;
    } catch {
      setResult({ change, status: 'failed' });
      return false;
    }
  }

  const write = useEffectEvent(() => {
    if (status !== 'saved') void saveNow();
  });
  const notify = useEffectEvent((next: ReaderDraftStatus) => onStatus?.(next));
  const clearSaved = useEffectEvent(() => {
    void clear();
  });
  useEffect(() => {
    if (wasDirty.current && !dirty && draft) clearSaved();
    wasDirty.current = dirty;
  }, [dirty, draft]);
  useEffect(() => {
    if (!draft || !dirty || suspend) return;
    const issued = generation.current;
    const timer = setTimeout(() => {
      if (issued === generation.current) write();
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, dirty, change, suspend]);
  useEffect(() => {
    notify(status);
    if (status === 'saving' || status === 'failed') return draft?.guard(warning);
  }, [draft, status, warning]);

  return { status, saveNow, clear };
}
