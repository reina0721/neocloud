import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// pnpm 生产清单还覆盖客户端构建打包、未被 Next 服务端追踪的包。
export async function bundleLicenses(frontend, destination) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, ['licenses', 'list', '--prod', '--json'], {
    cwd: frontend,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || 'pnpm license inventory failed');
  const inventory = [];
  for (const packages of Object.values(JSON.parse(result.stdout))) {
    for (const pkg of packages) {
      for (const source of pkg.paths) {
        const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
        assert.match(metadata.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
        assert.match(metadata.version, /^[a-z0-9.+_-]+$/i);
        const directory = join(destination, metadata.name, metadata.version);
        await mkdir(directory, { recursive: true });
        const files = [];
        async function collect(current, relative = '') {
          for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
            const path = join(relative, entry.name);
            if (entry.isDirectory()) await collect(join(current, entry.name), path);
            else if (
              entry.isFile() &&
              /^(licen[cs]e|copying|notice|authors)([._-]|$)|^copyright(?:notice)?(?:\.(?:txt|md))?$/i.test(
                entry.name,
              )
            ) {
              await mkdir(resolve(directory, relative), { recursive: true });
              await cp(join(current, entry.name), join(directory, path));
              files.push(path.replaceAll('\\', '/'));
            }
          }
        }
        await collect(source);
        // 保留身份、源码地址与 README 许可说明，不推测缺失的许可。
        await cp(join(source, 'package.json'), join(directory, 'package.json'));
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (entry.isFile() && /^readme([._-]|$)/i.test(entry.name)) {
            await cp(join(source, entry.name), join(directory, entry.name));
          }
        }
        inventory.push({
          name: metadata.name,
          version: metadata.version,
          license: metadata.license ?? pkg.license,
          repository: metadata.repository,
          files: files.sort(),
        });
      }
    }
  }
  assert.ok(inventory.length > 0, 'Production license inventory is empty');
  inventory.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  await writeFile(join(destination, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  console.log(`Bundled production dependency notices: ${inventory.length}`);
}
