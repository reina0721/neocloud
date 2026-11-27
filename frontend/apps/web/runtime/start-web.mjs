import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { configuredHttpOrigin } from './backend-proxy-rules.mjs';
import { createWebIngress } from './web-ingress.mjs';
import { readNeoCloudEnv } from './environment.mjs';

const thisFile = fileURLToPath(import.meta.url);
const loopback = '127.0.0.1';

function listen(server, port, host) {
  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      ready();
    });
  });
}

async function privatePort() {
  const reservation = createServer();
  await listen(reservation, 0, loopback);
  const { port } = reservation.address();
  await new Promise((done) => reservation.close(done));
  return port;
}

async function stopChild(child, stopped) {
  if (!child) return;
  if (child.connected) child.disconnect();
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await stopped;
  } finally {
    clearTimeout(force);
  }
}

export async function startWebHost() {
  const host = process.env.HOSTNAME || loopback;
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('Invalid Web Host port');
  const backend = configuredHttpOrigin(
    readNeoCloudEnv('BACKEND_URL') ??
      readNeoCloudEnv('DEFAULT_BACKEND_URL') ??
      'http://127.0.0.1:8080',
    'NEOCLOUD_BACKEND_URL',
  );
  const origin = readNeoCloudEnv('PUBLIC_ORIGIN');
  const publicOrigin = origin ? configuredHttpOrigin(origin, 'NEOCLOUD_PUBLIC_ORIGIN') : undefined;
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let child, stopped, gateway;
  try {
    const deadline = Date.now() + 60_000;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      shutdown.signal.throwIfAborted();
      const nextPort = await privatePort();
      child = fork(thisFile, ['--next-child'], {
        env: { ...process.env, NODE_ENV: 'production', HOSTNAME: loopback, PORT: String(nextPort) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const started = child;
      let exited = false;
      stopped = new Promise((done) => {
        started.once('error', () => {
          exited = true;
          done();
        });
        started.once('exit', () => {
          exited = true;
          done();
        });
      });
      const nextOrigin = new URL(`http://${loopback}:${nextPort}`);
      while (!exited && Date.now() < deadline) {
        shutdown.signal.throwIfAborted();
        try {
          const timeout = Math.max(1, Math.min(5000, deadline - Date.now()));
          const probe = await fetch(new URL('/login', nextOrigin), {
            signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeout)]),
          });
          await probe.body?.cancel();
          if (probe.ok && !exited) {
            gateway = createWebIngress({ backend, nextOrigin, publicOrigin });
            break;
          }
        } catch {
          // 下一轮继续探测本次启动的回环服务。
        }
        await delay(100);
      }
      if (gateway) break;
      await stopChild(child, stopped);
      child = undefined;
    }
    if (!gateway) throw new Error('Standalone Web Host did not become ready');
    await listen(gateway, port, host);
    console.log(`NeoCloud Web Host listening on ${host}:${port}`);
    await Promise.race([
      stopped,
      new Promise((done) => {
        if (shutdown.signal.aborted) done();
        else shutdown.signal.addEventListener('abort', done, { once: true });
      }),
    ]);
    if (!shutdown.signal.aborted) throw new Error('Standalone Web Host exited unexpectedly');
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    if (gateway) {
      const force = setTimeout(() => gateway.closeAllConnections(), 5000);
      try {
        await new Promise((done) => gateway.close(done));
      } finally {
        clearTimeout(force);
      }
    }
    await stopChild(child, stopped);
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  if (process.argv[2] === '--next-child' && process.connected) {
    process.once('disconnect', () => process.exit(0));
    await import('../server.js');
  } else {
    await startWebHost();
  }
}
