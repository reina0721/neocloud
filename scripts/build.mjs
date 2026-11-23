#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { copyStandalone, inspectStandaloneLinks } from '../frontend/tooling/copy-standalone.mjs';

const repo = resolve(import.meta.dirname, '..');
const frontend = join(repo, 'frontend');
const windows = process.platform === 'win32';
const { values } = parseArgs({
  options: {
    'go-executable': { type: 'string', default: 'go' },
    'no-web-cache': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log('node scripts/build.mjs [--go-executable PATH] [--no-web-cache]');
  process.exit(0);
}
if (Number(process.versions.node.split('.')[0]) < 24)
  throw new Error('本机构建需要 Node 24 或更高版本。');
if (!['win32', 'linux', 'darwin'].includes(process.platform) ||
    !['x64', 'arm64'].includes(process.arch))
  throw new Error('本机构建需要 64 位 Windows、Linux 或 macOS。');

const goos = windows ? 'windows' : process.platform;
const goarch = process.arch === 'x64' ? 'amd64' : 'arm64';
const target = `${goos}-${goarch}`;
const goEnv = { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' };
const output = join(repo, 'dist', 'native', target);
const nextDist = values['no-web-cache'] ? '.next/native-uncached' : '.next/native';
const buildEnv = {
  NEXT_DIST_DIR: nextDist,
  WEB_DEPLOYMENT_MODE: 'server',
  NEXT_PUBLIC_AUTH_MODE: 'backend',
  NEXT_PUBLIC_AUTH_API_BASE_URL: '/api/console/v1',
  CLOUDDRIVE_NATIVE_BUILD_CACHE: values['no-web-cache'] ? '0' : '1',
};

function run(command, args, cwd = repo, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`${command} ${args[0]} 退出 (${signal ?? code})`));
    });
  });
}

function pnpm(args) {
  const argv = ['--yes', 'pnpm@10.22.0', ...args];
  // 仅传入本脚本的固定标志。目录和构建配置使用 spawn 选项传入。
  return windows
    ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd ' + argv.join(' ')], frontend, { ...process.env, ...buildEnv })
    : run('npx', argv, frontend, { ...process.env, ...buildEnv });
}

async function measure(label, job) {
  const start = performance.now();
  await job();
  console.log(`${label} ${((performance.now() - start) / 1000).toFixed(1)} 秒`);
}

await mkdir(output, { recursive: true });
const outputRoot = await realpath(output);
const lockPath = join(outputRoot, 'build.lock');
const lock = await open(lockPath, 'wx').catch((error) => {
  if (error.code === 'EEXIST') throw new Error(`这个目标已有构建在运行：${lockPath}`);
  throw error;
});
let staging;
const next = join(frontend, 'apps', 'web', nextDist, 'standalone');
const archiveName = `clouddrive-${target}.${windows ? 'zip' : 'tar.gz'}`;
try {
  await lock.writeFile(String(process.pid));
  staging = await mkdtemp(join(outputRoot, 'stage-'));
  const work = join(staging, 'clouddrive');
  await mkdir(work);
  const go = values['go-executable'];
  await measure('依赖与生成', async () => {
    await pnpm(['install', '--frozen-lockfile', '--prefer-offline', '--prod=false']);
    await pnpm(['codegen:plugins']);
    await pnpm(['codegen:backend']);
    await run(go, ['generate', './internal/transport/http/api'], repo, goEnv);
    await pnpm(['codegen:contracts']);
  });
  const results = await Promise.allSettled([
    measure('Go 编译', () => run(go, ['build', '-trimpath', '-buildvcs=false', '-o', join(work, windows ? 'clouddrive.exe' : 'clouddrive'), './cmd/app'], repo, goEnv)),
    measure('Go 依赖许可', () => run(process.execPath, [
      join(repo, 'scripts', 'prepare-go-licenses.mjs'), '--output', join(work, 'third-party'),
      '--goos', goos, '--goarch', goarch, '--go-executable', go, '--from-module',
    ])),
    measure('Web 编译', () => pnpm(['--filter', '@clouddrive/web', 'build'])),
  ]);
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, '本机编译失败');
  await measure('归档', async () => {
    for (const file of ['LICENSE', 'NOTICE', 'SOURCES.json', 'config.example.yaml']) {
      await copyFile(join(repo, file), join(work, file));
    }
    await copyFile(join(repo, 'scripts', 'start-native-web.mjs'), join(work, 'start-web.mjs'));
    const archive = join(staging, archiveName);
    if (windows) {
      // 直接归档 Next 的追踪目录，避免在归档前复制完整的 node_modules。
      const links = await inspectStandaloneLinks(next);
      await writeFile(join(work, '.standalone-links.json'), JSON.stringify(links));
      await run(go, ['run', './internal/tools/native-archive',
        '--output', archive, '--work', work, '--web', next], repo, goEnv);
    } else {
      await copyStandalone(next, join(work, 'web'));
      await run('tar', ['-czf', archive, 'clouddrive'], staging);
    }
    await rename(join(staging, archiveName), join(outputRoot, archiveName));
  });
  console.log(join(outputRoot, archiveName));
} finally {
  try {
    if (staging) {
      const owned = relative(outputRoot, staging);
      if (!isAbsolute(owned) && owned === basename(staging) && owned.startsWith('stage-'))
        await rm(staging, { recursive: true, force: true });
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
