export async function devSetupMessage(base, tokenSource, signal) {
  try {
    const response = await fetch(base + "/api/console/v1/auth/setup-policy", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (response.ok) {
      const policy = await response.json();
      signal.throwIfAborted();
      if (policy?.initialized === true) return `登录：${base}/login`;
      if (policy?.initialized === false)
        return `首次设置：${base}/setup；令牌：${tokenSource}`;
    } else {
      await response.body?.cancel();
    }
  } catch {
    signal.throwIfAborted();
  }
  return `无法确认首次设置状态。登录：${base}/login`;
}
