import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA, ALLOWED, loadNotes, atomicWrite } from './store.mjs';
import { writeLock } from './lock.mjs';

const config = path.join(DATA, 'folders.json');
const ignored = new Set(['.git', '.codex', '.agents', '.runtime', 'node_modules', '$RECYCLE.BIN', 'System Volume Information']);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
async function readConfig() {
  try { return JSON.parse(await fs.readFile(config, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function writeConfig(folders) {
  await fs.mkdir(DATA, { recursive: true });
  const tmp = config + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(folders, null, 2)); await fs.rename(tmp, config);
}
export async function listFolders() { return readConfig(); }
export async function connectFolder(folderPath) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('请选择一个本机文件夹，或粘贴完整路径');
  const root = await fs.realpath(folderPath);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('这不是文件夹');
  if (inside(root, path.resolve(DATA))) throw new Error('请接入原始材料文件夹，不要接入应用自己的数据目录');
  const connection = await writeLock(async () => {
    const folders = await readConfig();
    const existing = folders.find(f => same(f.path, root));
    if (existing) { existing.enabled = true; await writeConfig(folders); return existing; }
    if (folders.some(f => f.enabled && (inside(root, f.path) || inside(f.path, root)))) throw new Error('这个目录与已接入的文件夹重叠，无需重复接入');
    const folder = { id: randomUUID(), path: root, name: path.basename(root), enabled: true, createdAt: new Date().toISOString(), status: 'pending' };
    folders.push(folder); await writeConfig(folders); return folder;
  });
  await syncFolders();
  return (await listFolders()).find(f => f.id === connection.id);
}
export async function disconnectFolder(id) {
  await writeLock(async () => {
    const folders = await readConfig(), folder = folders.find(f => f.id === id);
    if (!folder) throw new Error('没有找到这个连接');
    folder.enabled = false; folder.status = 'detached'; await writeConfig(folders);
    for (const n of await loadNotes()) if (n.linkedSource?.connectionId === id) {
      n.linkedSource.status = 'detached'; await atomicWrite(n);
    }
  });
}
async function collect(root) {
  const groups = new Map(), warnings = [];
  let count = 0;
  async function visit(dir, depth) {
    if (depth > 30) { warnings.push(`目录层级超过 30 层，暂未读取：${path.relative(root, dir)}`); return; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { warnings.push(`暂时无法读取：${path.relative(root, dir) || '.'}`); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (inside(full, path.resolve(DATA))) continue;
      if (entry.isDirectory()) { await visit(full, depth + 1); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !ALLOWED.has(ext)) continue;
      if (++count > 10000) throw new Error('文件夹超过 10000 份支持的材料，请按较小的子文件夹接入');
      try {
        const stat = await fs.stat(full), relative = path.relative(root, full);
        const key = path.relative(root, dir) || '.';
        const items = groups.get(key) || [];
        items.push({ name: entry.name, relative, ext, size: stat.size, mtimeMs: stat.mtimeMs }); groups.set(key, items);
      } catch { warnings.push(`暂时无法读取：${path.relative(root, full)}`); }
    }
  }
  await visit(root, 0);
  return { groups, warnings, count };
}
export async function syncFolders() {
  return writeLock(async () => {
    const folders = await readConfig();
    if (!folders.length) return { folders: [], added: 0, changed: 0 };
    const notes = await loadNotes(); let added = 0, changed = 0;
    for (const folder of folders.filter(f => f.enabled)) {
      const associated = notes.filter(n => n.linkedSource?.connectionId === folder.id);
      try {
        const actual = await fs.realpath(folder.path);
        if (!same(actual, folder.path)) throw new Error('文件夹指向发生变化，请重新接入');
        const { groups, warnings, count } = await collect(folder.path);
        const seen = new Set();
        for (const [relativeDir, items] of groups) {
          const fingerprint = createHash('sha256').update(JSON.stringify(items)).digest('hex');
          let note = associated.find(n => n.linkedSource.relativeDir === relativeDir);
          if (note) seen.add(note.id);
          if (note?.linkedSource.fingerprint === fingerprint && note.linkedSource.status === 'available') continue;
          const now = new Date().toISOString();
          if (!note) {
            note = { id: randomUUID(), title: relativeDir === '.' ? folder.name : path.basename(relativeDir), comment: '', text: '', source: '', tags: [], facets: [], favorite: false, trashed: false, attachments: [], createdAt: now };
            added++;
          } else changed++;
          const texts = [];
          for (const item of items.filter(i => ['.txt', '.md'].includes(i.ext))) {
            if (texts.join('').length >= 500000) break;
            if (item.size > 2 * 1024 * 1024) { warnings.push(`大文本仅保留原件供 Agent 按需读取：${item.relative}`); continue; }
            try { const original = await fs.readFile(path.join(folder.path, item.relative), 'utf8'); texts.push(`【原文件：${item.relative}】\n${original}`); }
            catch { warnings.push(`未能读取文字：${item.relative}`); }
          }
          note.text = texts.join('\n\n').slice(0, 500000);
          note.linkedSource = { connectionId: folder.id, root: folder.path, relativeDir, directory: path.resolve(folder.path, relativeDir), fingerprint, status: 'available' };
          note.attachments = items.map(i => ({ id: createHash('sha256').update(i.relative).digest('hex').slice(0, 24), file: createHash('sha256').update(i.relative).digest('hex').slice(0, 32) + i.ext,
            name: i.name, externalRelativePath: i.relative, type: ALLOWED.get(i.ext), size: i.size, mtimeMs: i.mtimeMs }));
          note.revision = randomUUID(); note.updatedAt = now; await atomicWrite(note);
        }
        for (const note of associated) if (!seen.has(note.id) && !groups.has(note.linkedSource.relativeDir)) {
          if (warnings.length) continue;
          if (note.linkedSource.status !== 'missing') { note.linkedSource.status = 'missing'; note.revision = randomUUID(); await atomicWrite(note); changed++; }
        }
        folder.status = warnings.length ? 'partial' : 'available'; folder.fileCount = count; folder.groupCount = groups.size; folder.warnings = warnings.slice(0, 30); delete folder.error;
      } catch (error) {
        folder.status = 'unavailable'; folder.error = error.code === 'ENOENT' ? '文件夹暂不可用，请检查磁盘或路径' : error.message;
        for (const note of associated) if (note.linkedSource.status !== 'unavailable') { note.linkedSource.status = 'unavailable'; note.revision = randomUUID(); await atomicWrite(note); }
      }
      folder.scannedAt = new Date().toISOString();
    }
    await writeConfig(folders);
    return { folders, added, changed };
  });
}
export async function linkedAssetPath(note, asset) {
  const folder = (await readConfig()).find(f => f.id === note.linkedSource.connectionId && f.enabled);
  if (!folder) throw new Error('原文件夹已断开；标注仍然保留');
  const candidate = path.resolve(folder.path, asset.externalRelativePath);
  if (!inside(candidate, folder.path)) throw new Error('原件路径超出了接入范围');
  const actual = await fs.realpath(candidate);
  if (!inside(actual, folder.path)) throw new Error('原件指向接入范围之外，已停止读取');
  const stat = await fs.stat(actual);
  if (!stat.isFile()) throw new Error('原件不是文件');
  if (stat.size !== asset.size || stat.mtimeMs !== asset.mtimeMs) throw new Error('原件刚刚发生变化，请同步后重新读取');
  return actual;
}
