import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isPublicationTemporaryFile,
  publishArtifacts,
  withPublicationRetry,
} from './publish-artifacts.mjs';

test('Windows sharing violations retry without replacing the atomic writer or hiding permanent errors', async () => {
  let calls = 0;
  const waits = [];
  const options = { platform: 'win32', wait: async (milliseconds) => waits.push(milliseconds) };
  const failure = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  const result = await withPublicationRetry(async () => {
    if (++calls < 3) throw failure;
    return 'published';
  }, options);
  assert.equal(result, 'published');
  assert.deepEqual(waits, [25, 50]);
  calls = 0;
  await assert.rejects(
    withPublicationRetry(async () => {
      calls++;
      throw failure;
    }, options),
    (error) => error === failure,
  );
  assert.equal(calls, 20);
  calls = 0;
  await assert.rejects(
    withPublicationRetry(
      async () => {
        calls++;
        throw failure;
      },
      { ...options, platform: 'linux' },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  const diskFailure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  await assert.rejects(
    withPublicationRetry(async () => {
      throw diskFailure;
    }, options),
    (error) => error === diskFailure,
  );
});

test('a no-op reconcile preserves the files observed by module watchers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clouddrive-codegen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = [
    { path: join(root, 'composition', 'composition.ts'), content: 'export {};\n' },
  ];
  await publishArtifacts(artifacts);
  const before = await stat(artifacts[0].path);
  await publishArtifacts(artifacts);
  const after = await stat(artifacts[0].path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs ?? after.mtimeMs, before.mtimeNs ?? before.mtimeMs);
});

test('independent generators publish complete modules while a reader is active', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clouddrive-codegen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'composition.ts');
  const texts = ['a', 'b', 'c'].map(
    (letter) => `export const value = '${letter.repeat(256 * 1024)}';\n`,
  );
  await publishArtifacts([{ path, content: texts[0] }]);
  const script = `
    import { publishArtifacts } from ${JSON.stringify(new URL('./publish-artifacts.mjs', import.meta.url).href)};
    const [path, letter] = process.argv.slice(1);
    for (let i = 0; i < 13; i++) {
      await publishArtifacts([{path, content: "export const value = '" + (i % 2 ? 'a' : letter).repeat(256 * 1024) + "';\\n"}]);
    }
  `;
  let finished = false;
  const writers = Promise.all(
    ['b', 'c'].map(
      (letter) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--input-type=module', '-e', script, path, letter],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)),
          );
        }),
    ),
  ).finally(() => {
    finished = true;
  });
  let reads = 0;
  try {
    while (!finished) {
      assert.ok(
        texts.includes(await readFile(path, 'utf8')),
        'reader observed a partial or unexpected module',
      );
      reads++;
    }
  } finally {
    await writers;
  }
  assert.ok(reads > 0);
  assert.ok(texts.slice(1).includes(await readFile(path, 'utf8')));
});

test('reconciliation excludes another publisher’s temporary module, not stale modules', () => {
  assert.equal(isPublicationTemporaryFile('/generated/composition.ts.12345678'), true);
  assert.equal(isPublicationTemporaryFile('/app/page.tsx.4294967295'), true);
  assert.equal(isPublicationTemporaryFile('/generated/obsolete.ts'), false);
  assert.equal(isPublicationTemporaryFile('/generated/obsolete.txt'), false);
});
