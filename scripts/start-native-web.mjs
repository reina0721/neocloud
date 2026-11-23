#!/usr/bin/env node
import { copyFile, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await realpath(join(import.meta.dirname, 'web'));
if (process.platform === 'win32') {
  const links = JSON.parse(await readFile(join(import.meta.dirname, '.standalone-links.json'), 'utf8'));
  function within(candidate) {
    const path = resolve(root, candidate);
    const subpath = relative(root, path);
    if (!subpath || isAbsolute(subpath) || subpath === '..' || subpath.startsWith('..' + sep))
      throw new Error(`无效的运行依赖路径 ${candidate}`);
    return path;
  }
  for (const link of links) {
    const path = within(link.path);
    const target = within(link.target);
    await mkdir(dirname(path), { recursive: true });
    if (link.directory) {
      try {
        await symlink(target, path, 'junction');
      } catch (error) {
        if (error.code !== 'EEXIST' || !((await lstat(path)).isSymbolicLink()) ||
            (await realpath(path)) !== (await realpath(target))) throw error;
      }
    } else {
      await copyFile(target, path);
    }
  }
}
const server = join(root, 'apps', 'web', 'server.js');
process.env.HOSTNAME ||= '127.0.0.1';
process.env.PORT ||= '4173';
await import(pathToFileURL(server).href);
