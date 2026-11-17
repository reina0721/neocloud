import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyStandalone } from './copy-standalone.mjs';

test('relocated junction keeps peer dependency resolution without the original build tree', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'clouddrive-junction-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'build');
  const modules = join(root, 'store', 'node_modules');
  const target = join(modules, 'dependency');
  await mkdir(target, { recursive: true });
  await mkdir(join(modules, 'helper'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(target, 'index.js'), 'module.exports = require("helper");');
  await writeFile(join(modules, 'helper', 'index.js'), 'module.exports = "relocated dependency";');
  await writeFile(join(root, 'server.cjs'), 'module.exports = require("dependency");');
  await symlink(
    target,
    join(root, 'node_modules', 'dependency'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const relocated = join(base, 'relocated');
  await copyStandalone(root, relocated);
  await rm(root, { recursive: true });
  assert.equal(
    createRequire(import.meta.url)(join(relocated, 'server.cjs')),
    'relocated dependency',
  );
});

test('untraced external dependencies fail before copying the runtime', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'clouddrive-junction-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'build');
  const external = join(base, 'external');
  await mkdir(root);
  await mkdir(external);
  await writeFile(join(root, 'server.cjs'), 'original');
  await symlink(
    external,
    join(root, 'dependency'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(copyStandalone(root, join(base, 'relocated')), /escapes traced output/);
  assert.equal(await readFile(join(root, 'server.cjs'), 'utf8'), 'original');
});
