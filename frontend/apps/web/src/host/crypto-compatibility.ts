/** 显式安装 HTTP 页面缺少的 UUID 标准能力；随机数仍来自浏览器 CSPRNG。 */
export function installUUIDCompatibility(target: Crypto = globalThis.crypto): void {
  if (typeof target.randomUUID === 'function') return;
  Object.defineProperty(target, 'randomUUID', {
    configurable: true,
    value: (): ReturnType<Crypto['randomUUID']> => {
      const bytes = target.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}
