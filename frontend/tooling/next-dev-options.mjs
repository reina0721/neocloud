/** 两个 dev 入口共享同一显式选项；不在编译器失败时静默切换。 */
export function nextDevOptions(environment = process.env) {
  const bundler = readNeoCloudEnv('DEV_BUNDLER', environment);
  if (bundler && bundler !== 'webpack' && bundler !== 'turbopack') {
    throw new Error('NEOCLOUD_DEV_BUNDLER must be webpack or turbopack.');
  }
  return bundler === 'webpack' ? ['--webpack'] : [];
}
import { readNeoCloudEnv } from '../apps/web/runtime/environment.mjs';
