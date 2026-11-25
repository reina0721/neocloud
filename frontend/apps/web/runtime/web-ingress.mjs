import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream';
import { backendRequestHeaders } from './backend-proxy-rules.mjs';

function endToEnd(headers) {
  const connection = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
  const hopHeaders = new Set([
    ...connection,
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.has(name)));
}

function forward(incoming, client, target, headers) {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send(target, { method: incoming.method, path: incoming.url, headers });
  let response;
  upstream.on('response', (value) => {
    response = value;
    if (client.destroyed) {
      value.destroy();
      return;
    }
    client.writeHead(value.statusCode ?? 502, endToEnd(value.headers));
    pipeline(value, client, () => {});
  });
  upstream.on('error', () => {
    if (client.destroyed) return;
    if (client.headersSent) client.destroy();
    else client.writeHead(502).end();
  });
  incoming.on('error', () => upstream.destroy());
  client.once('close', () => {
    if (!client.writableFinished) {
      upstream.destroy();
      response?.destroy();
    }
  });
  upstream.flushHeaders();
  incoming.pipe(upstream);
}

export function createWebIngress({ backend, nextOrigin, publicOrigin }) {
  // DAV 的传输期限和配额由 Go 拥有，入口只流式转发。
  return createServer({ requestTimeout: 0 }, (incoming, response) => {
    const target = incoming.url ?? '';
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
      response.writeHead(400).end();
      return;
    }
    const path = target.split('?', 1)[0];
    const headers = endToEnd(incoming.headers);
    if (path !== '/dav' && !path.startsWith('/dav/')) {
      forward(incoming, response, nextOrigin, headers);
      return;
    }

    try {
      const host = headers.host;
      if (typeof host !== 'string' || !host || host.length > 320 || /[\s,@/\\?#]/.test(host))
        throw new Error('Invalid public authority');
      const scheme = publicOrigin?.host === host ? publicOrigin.protocol : 'http:';
      const address = new URL(`${scheme}//${host}${target}`);
      if (address.pathname !== '/dav' && !address.pathname.startsWith('/dav/'))
        throw new Error('Invalid DAV target');
      const checked = backendRequestHeaders(address.href, new Headers(headers), backend);
      checked.set('host', backend.host);
      forward(incoming, response, backend, Object.fromEntries(checked));
    } catch {
      response.writeHead(403).end();
    }
  });
}
