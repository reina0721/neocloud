'use client';

import { useFeedback } from '@neocloud/ui-adapter/feedback-context';
import { useCallback, useEffect, useRef } from 'react';

/** 操作成功通知由发起的文件页面拥有，离开后释放自己的通知。 */
export function useFileActionFeedback(scope: string) {
  const { notify, dismiss } = useFeedback();
  const notice = useRef<string | undefined>(undefined);
  const release = useCallback(() => {
    if (notice.current === undefined) return;
    dismiss(notice.current);
    notice.current = undefined;
  }, [dismiss]);
  useEffect(() => release, [release, scope]);

  return useCallback(
    (title: string) => {
      release();
      notice.current = notify({ title, tone: 'success', duration: 'transient' });
    },
    [notify, release],
  );
}
