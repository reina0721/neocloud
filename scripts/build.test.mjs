import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const toolchain = `
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

childProcess.spawn = (command, args, options) => {
  const child = new EventEmitter();
  setImmediate(async () => {
    try {
      if (args.join(' ').endsWith('--filter @neocloud/web build')) {
        const dist = options.env.NEXT_DIST_DIR;
        const web = join(options.cwd, 'apps', 'web');
        const output = join(web, dist);
        await mkdir(join(output, 'standalone'), { recursive: true });
        await writeFile(join(output, 'standalone', 'server.js'), '模拟 Web 输出');
        await writeFile(join(web, 'next-env.d.ts'), 'import "./' + dist + '/types/routes.d.ts";');
        if (options.env.NEOCLOUD_NATIVE_BUILD_CACHE === '1') {
          await mkdir(join(output, 'cache'), { recursive: true });
          await writeFile(join(output, 'cache', 'turbopack'), '模拟缓存');
        }
        if (process.env.CLOUDDRIVE_TEST_WEB_FAILURE === '1') {
          child.emit('exit', 29);
          return;
        }
      }
      if (command === 'tar') {
        await writeFile(args[1], '模拟新归档');
      } else if (args[0] === 'run' && args.includes('./internal/tools/native-archive')) {
        await writeFile(args[args.indexOf('--output') + 1], '模拟新归档');
      }
      child.emit('exit', 0);
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
};
syncBuiltinESMExports();
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clouddrive-native-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    'scripts/build.mjs', 'scripts/start-native-web.mjs', 'frontend/tooling/copy-standalone.mjs',
    'LICENSE', 'NOTICE', 'SOURCES.json', 'config.example.yaml',
  ]) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL('../' + file, import.meta.url), destination);
  }
  const web = join(root, 'frontend', 'apps', 'web');
  await mkdir(join(web, '.next', 'dev'), { recursive: true });
  await writeFile(join(web, '.next', 'dev', 'lock'), '开发服务');
  await writeFile(join(web, 'next-env.d.ts'), '开发类型声明');
  const preload = join(root, 'toolchain.mjs');
  await writeFile(preload, toolchain);

  const windows = process.platform === 'win32';
  const target = `${windows ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const output = join(root, 'dist', 'native', target);
  const archive = `neocloud-${target}.${windows ? 'zip' : 'tar.gz'}`;
  return {
    root, web, output, archive,
    run: (args = [], failWeb = false) => spawnSync(
      process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts', 'build.mjs'), ...args],
      {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, CLOUDDRIVE_TEST_WEB_FAILURE: failWeb ? '1' : '0' },
      },
    ),
  };
}

test('打包成功后清理中间输出并保留归档和复用缓存', async (t) => {
  const { web, output, archive, run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(output), [archive]);
  assert.equal(await readFile(join(output, archive), 'utf8'), '模拟新归档');
  assert.deepEqual(await readdir(join(web, '.next', 'native')), ['cache']);
  assert.equal(await readFile(join(web, 'next-env.d.ts'), 'utf8'), '开发类型声明');
  assert.equal(await readFile(join(web, '.next', 'dev', 'lock'), 'utf8'), '开发服务');
});

test('无缓存构建失败后清理临时输出并保留上一次的归档', async (t) => {
  const { web, output, archive, run } = await fixture(t);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, archive), '已有归档');
  const result = run(['--no-web-cache'], true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /退出 \(29\)/);
  assert.deepEqual(await readdir(output), [archive]);
  assert.equal(await readFile(join(output, archive), 'utf8'), '已有归档');
  assert.equal(existsSync(join(web, '.next', 'native-uncached')), false);
  assert.equal(await readFile(join(web, 'next-env.d.ts'), 'utf8'), '开发类型声明');
});

test('打包不进入被重定向的 Web 输出目录', async (t) => {
  const { root, web, output, run } = await fixture(t);
  const other = join(root, 'unrelated');
  await mkdir(other);
  await writeFile(join(other, 'keep'), '不属于打包');
  await symlink(other, join(web, '.next', 'native'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Web 输出目录不能重定向/);
  assert.deepEqual(await readdir(output), []);
  assert.deepEqual(await readdir(other), ['keep']);
});
