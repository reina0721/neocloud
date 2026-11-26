'use client';
import { useEffect, useState } from 'react';

export function useCatalogRequest<T>(load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<{
    load: typeof load;
    revision: number;
    result: { value: T } | { error: unknown };
  }>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setSettled({ load, revision, result: { value } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled({ load, revision, result: { error } });
      },
    );
    return () => controller.abort();
  }, [enabled, load, revision]);
  const result =
    enabled && settled?.load === load && settled.revision === revision ? settled.result : undefined;
  return { result, refresh: () => setRevision((value) => value + 1) };
}
