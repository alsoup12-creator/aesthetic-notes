import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.env.AESTHETIC_NOTES_DATA || path.resolve(import.meta.dirname, '../data');
let local = Promise.resolve();
export function writeLock(work) {
  const result = local.then(async () => {
    await fs.mkdir(root, { recursive: true });
    const lock = path.join(root, '.write-lock');
    const started = Date.now();
    let handle;
    while (!handle) {
      try { handle = await fs.open(lock, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 180000) await fs.unlink(lock); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (Date.now() - started > 20000) throw new Error('笔记库正在更新，请稍后重试');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    try { return await work(); }
    finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
  });
  local = result.catch(() => {});
  return result;
}
