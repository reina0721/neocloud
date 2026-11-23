import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readdir, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// 保持 pnpm 模块解析拓扑；Windows junction 是绝对路径，搬迁时须重新指向新追踪目录。
export async function inspectStandaloneLinks(source) {
  const root = await realpath(source);
  const links = [];
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = relative(root, await realpath(child));
        assert.ok(
          !isAbsolute(target) && target !== '..' && !target.startsWith('..' + sep),
          `Standalone dependency escapes traced output: ${child}`,
        );
        links.push({
          path: relative(root, child),
          target,
          directory: (await lstat(join(root, target))).isDirectory(),
        });
      } else if (entry.isDirectory()) await inspect(child);
    }
  }
  await inspect(root);
  return links;
}

export async function copyStandalone(source, destination) {
  const root = await realpath(source);
  const output = resolve(destination);
  const links = await inspectStandaloneLinks(root);
  await cp(root, output, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (path) => !(await lstat(path)).isSymbolicLink(),
  });
  for (const link of links) {
    const path = join(output, link.path);
    const target = join(output, link.target);
    await mkdir(dirname(path), { recursive: true });
    await symlink(
      process.platform === 'win32' ? target : relative(dirname(path), target),
      path,
      link.directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file',
    );
  }
}
