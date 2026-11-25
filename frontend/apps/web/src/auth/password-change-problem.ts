import type { ApiError } from '../api/json-client';

/** 改密接口保留 401 兼容性，同时用原因区分输入错误和会话失效。 */
export function isCurrentPasswordMismatch(error: ApiError): boolean {
  const payload = error.payload;
  if (
    error.code !== 'http' ||
    error.status !== 401 ||
    !payload ||
    typeof payload !== 'object' ||
    !('error' in payload)
  ) {
    return false;
  }
  const problem = payload.error;
  return (
    !!problem &&
    typeof problem === 'object' &&
    'code' in problem &&
    problem.code === 'unauthenticated' &&
    'reason' in problem &&
    problem.reason === 'current-password-invalid'
  );
}
