import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Captured at startup, not at request time: an old process must keep reporting
// the code it loaded even when its source files are replaced on disk.
export async function runtimeRevision(root) {
  const files = ['server.mjs', ...(await fs.readdir(path.join(root, 'lib'))).filter(name => name.endsWith('.mjs')).map(name => 'lib/' + name)].sort();
  const manifest = await Promise.all(files.map(async file => `${file}:${createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')}\n`));
  return createHash('sha256').update(manifest.join('')).digest('hex');
}
