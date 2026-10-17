import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { writeLock } from './lock.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA = process.env.AESTHETIC_NOTES_DATA || path.join(ROOT, 'data');
const NOTES = path.join(DATA, 'notes');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ALLOWED = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.avif', 'image/avif'],
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.md', 'text/plain']
]);
const MAX_FILE = 40 * 1024 * 1024;
export function noteDir(id) {
  if (!ID.test(id)) throw new Error('笔记编号无效');
  return path.join(NOTES, id);
}
function string(value, max = 100000) { return String(value ?? '').slice(0, max); }
function array(value) { return Array.isArray(value) ? [...new Set(value.map(v => string(v, 60).trim()).filter(Boolean))].slice(0, 30) : []; }
function normalize(input, old = {}) {
  return {
    ...old, id: old.id || randomUUID(), title: string(input.title ?? old.title, 200).trim() || '一则新记录',
    comment: string(input.comment ?? old.comment), text: string(input.text ?? old.text, 500000), source: string(input.source ?? old.source, 3000),
    facets: array(input.facets ?? old.facets), tags: array(input.tags ?? old.tags), favorite: Boolean(input.favorite ?? old.favorite),
    trashed: Boolean(old.trashed), attachments: [...(old.attachments || [])], revision: randomUUID(),
    createdAt: old.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}
export async function loadNotes() {
  await fs.mkdir(NOTES, { recursive: true });
  const entries = await fs.readdir(NOTES, { withFileTypes: true });
  const notes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    try { notes.push(await readNote(entry.name)); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取笔记 ${entry.name}，请检查原文件：${error.message}`); }
  }
  return notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function readNote(id) {
  const note = JSON.parse(await fs.readFile(path.join(noteDir(id), 'note.json'), 'utf8'));
  if (!note.revision) note.revision = 'legacy-' + createHash('sha256').update(JSON.stringify([note.comment, note.text, note.attachments, note.updatedAt])).digest('hex').slice(0, 24);
  return note;
}
export async function atomicWrite(note) {
  const dir = noteDir(note.id);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'note.json');
  const temp = path.join(dir, `.${randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(note, null, 2), 'utf8');
  try { await fs.copyFile(target, path.join(dir, 'note.previous.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rename(temp, target);
}
function checkFile(file) {
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error(`暂不支持 ${ext || '无扩展名'} 文件，请导入图片、PDF、TXT 或 Markdown`);
  if (file.size > MAX_FILE) throw new Error('单个文件请控制在 40 MB 以内');
  return ext;
}
async function addAsset(id, name, bytes, ext) {
  const file = randomUUID() + ext;
  const dir = path.join(noteDir(id), 'assets');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), bytes);
  return { id: randomUUID(), name: path.basename(name.replaceAll('\\', '/')), file, type: ALLOWED.get(ext), size: bytes.length };
}
export async function saveNote(input, files = [], kept) {
  return writeLock(() => saveNoteUnlocked(input, files, kept));
}
async function saveNoteUnlocked(input, files = [], kept) {
  const old = input.id ? await readNote(input.id) : {};
  if (input.expectedRevision && old.revision !== input.expectedRevision) throw new Error('这则笔记已在别处修改，请重新打开后继续');
  if (old.linkedSource && (files.length || ('text' in input && input.text !== old.text))) throw new Error('已接入的原件请在原文件夹中修改；这里可以写自己的标注');
  const note = normalize(input, old);
  if (files.length && files.length + (kept?.length ?? old.attachments?.length ?? 0) > 40 && !old.linkedSource) throw new Error('每条上传记录最多支持 40 个附件');
  const extensions = files.map(checkFile);
  if (kept) note.attachments = note.attachments.filter(a => kept.includes(a.id));
  const added = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const bytes = Buffer.from(await file.arrayBuffer());
      const asset = await addAsset(note.id, file.name, bytes, extensions[i]);
      added.push(asset);
      note.attachments.push(asset);
      if (!note.text && ['.txt', '.md'].includes(extensions[i])) note.text = bytes.toString('utf8').slice(0, 500000);
    }
    if (!old.id && !input.title) note.title = (note.text.trim().split('\n')[0] || files[0]?.name?.replace(/\.[^.]+$/, '') || note.comment.trim().split('\n')[0] || '一则新记录').slice(0, 70);
    await atomicWrite(note);
    return note;
  } catch (error) {
    for (const a of added) await fs.unlink(path.join(noteDir(note.id), 'assets', a.file)).catch(() => {});
    throw error;
  }
}
export async function changeNote(id, change) {
  return writeLock(() => changeNoteUnlocked(id, change));
}
async function changeNoteUnlocked(id, change) {
  const note = await readNote(id);
  if ('favorite' in change) note.favorite = Boolean(change.favorite);
  if ('trashed' in change) note.trashed = Boolean(change.trashed);
  note.updatedAt = new Date().toISOString();
  await atomicWrite(note);
  return note;
}
export async function assetBytes(note, asset) {
  return fs.readFile(await assetPath(note, asset));
}
export async function assetPath(note, asset) {
  if (asset.externalRelativePath && note.linkedSource) {
    const { linkedAssetPath } = await import('./folders.mjs');
    return linkedAssetPath(note, asset);
  }
  if (path.basename(asset.file) !== asset.file || !ALLOWED.has(path.extname(asset.file))) throw new Error('附件路径无效');
  return path.join(noteDir(note.id), 'assets', asset.file);
}
export function displayNote(note) {
  const current = Boolean(note.organization && note.organization.revision === note.revision);
  return { ...note, title: current ? note.organization.title : note.title, facets: current ? note.organization.facets : note.facets,
    tags: current ? note.organization.tags : note.tags, organizationState: current ? 'ready' : note.organization ? 'stale' : 'pending' };
}
export async function organizeNote(id, revision, result) {
  return writeLock(async () => {
    const note = await readNote(id);
    if (!revision || revision !== note.revision) throw new Error('原件或标注已经变化，请重新读取后再整理');
    if (!result || typeof result.title !== 'string' || !result.title.trim() || !Array.isArray(result.facets) || !Array.isArray(result.tags)) throw new Error('整理结果需要包含 title、facets 和 tags');
    note.organization = { revision, title: string(result.title, 120), facets: array(result.facets), tags: array(result.tags),
      summary: string(result.summary, 10000), observations: string(result.observations, 20000),
      preferenceInterpretation: string(result.preferenceInterpretation, 20000), evidence: string(result.evidence, 20000),
      relevantTasks: array(result.relevantTasks), organizedAt: new Date().toISOString() };
    await atomicWrite(note);
    return displayNote(note);
  });
}
export function markdown(note, absolute = false) {
  const shown = displayNote(note);
  const lines = [`# ${shown.title}`, '', `笔记编号：${note.id}`, `原件与标注版本：${note.revision || 'legacy'}`, `创建：${note.createdAt}`, `更新：${note.updatedAt}`, `关注：${shown.facets.join('、') || '尚未整理'}`, `标签：${shown.tags.join('、') || '尚未整理'}`, ''];
  if (note.linkedSource) lines.push('## 原目录', '', note.linkedSource.directory, `状态：${note.linkedSource.status}`, '目录分组只表示文件位置关系，具体关联由 Agent 阅读原件判断。', '');
  if (note.source) lines.push('## 来源', '', note.source, '');
  lines.push('## 用户点评（原话）', '', note.comment || '（尚未填写；收藏不代表认可材料的全部方面。）', '');
  if (note.text) lines.push('## 原文 / 产品体验记录', '', note.text, '');
  lines.push('## 原始附件', '');
  for (const a of note.attachments) {
    const target = absolute ? (a.externalRelativePath && note.linkedSource ? path.join(note.linkedSource.root, a.externalRelativePath) : path.join(noteDir(note.id), 'assets', a.file)).replaceAll('\\', '/') : `assets/${a.file}`;
    lines.push(`- ${a.name}：${target}`);
  }
  if (note.organization) lines.push('', `## Agent 整理（${shown.organizationState === 'ready' ? '对应当前版本' : '原件已变化，需更新'}）`, '', JSON.stringify(note.organization, null, 2));
  return lines.join('\n');
}
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
export function makeZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const filename = Buffer.from(name);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(33, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, filename, data); central.push(c, filename);
    offset += h.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export async function referenceZip(ids, task = '') {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new Error('请选择 1 至 200 条笔记');
  const notes = await Promise.all([...new Set(ids)].map(readNote));
  const intro = ['# 审美笔记 · 本次参考', '', '## 当前任务', '', string(task, 20000) || '由使用者补充。', '', '## 使用原则', '', '先判断本次任务需要参考的维度，再阅读相关原件与用户点评。用户点评是个人偏好的证据；收藏本身不代表全盘认可。AI 的解释应标明推测，不能伪装成用户原话。跨领域迁移需要说明关联；没有相关参考时如实说明。', '', '## 笔记索引', '', ...notes.map(n => `- ${n.title}：${n.id}/note.md`)].join('\n');
  const entries = [['开始阅读.md', intro], ['manifest.json', JSON.stringify({ version: 1, task, notes }, null, 2)]];
  for (const n of notes) {
    entries.push([`${n.id}/note.md`, markdown(n)]);
    for (const a of n.attachments) entries.push([`${n.id}/assets/${a.file}`, await assetBytes(n, a)]);
  }
  return makeZip(entries);
}
export async function backup() {
  const notes = await loadNotes();
  const items = [];
  for (const note of notes) {
    const assets = [];
    for (const a of note.attachments) {
      try { assets.push({ ...a, base64: (await assetBytes(note, a)).toString('base64') }); }
      catch { if (!a.externalRelativePath) throw new Error(`无法读取附件：${a.name}`); assets.push({ ...a, unavailable: true }); }
    }
    items.push({ ...note, attachments: assets });
  }
  const { listFolders } = await import('./folders.mjs');
  return { format: 'aesthetic-notes-backup', version: 1, exportedAt: new Date().toISOString(), notes: items, connectedFolders: await listFolders() };
}
export async function restore(payload) {
  return writeLock(() => restoreUnlocked(payload));
}
async function restoreUnlocked(payload) {
  if (payload?.format !== 'aesthetic-notes-backup' || payload.version !== 1 || !Array.isArray(payload.notes)) throw new Error('这不是受支持的审美笔记备份');
  if (payload.notes.length > 3000) throw new Error('单次最多恢复 3000 条笔记');
  const prepared = payload.notes.map(raw => {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.attachments) || raw.attachments.length > 10000) throw new Error('备份内容不完整');
    const assets = raw.attachments.filter(a => !a.unavailable).map(a => {
      if (!a || typeof a.name !== 'string' || typeof a.base64 !== 'string') throw new Error('备份附件无效');
      const bytes = Buffer.from(a.base64, 'base64');
      const ext = checkFile({ name: a.name, size: bytes.length });
      return { name: a.name, bytes, ext };
    });
    const n = normalize(raw);
    if (raw.linkedSource) n.source = raw.linkedSource.directory;
    if (raw.attachments.some(a => a.unavailable)) n.unavailableOriginals = raw.attachments.filter(a => a.unavailable).map(a => ({ name: a.name, externalRelativePath: a.externalRelativePath }));
    n.trashed = Boolean(raw.trashed);
    if (typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt))) n.createdAt = new Date(raw.createdAt).toISOString();
    return { n, assets };
  });
  const created = [];
  try {
    for (const { n, assets } of prepared) {
      created.push(n.id);
      for (const a of assets) n.attachments.push(await addAsset(n.id, a.name, a.bytes, a.ext));
      await atomicWrite(n);
    }
  } catch (error) {
    for (const id of created) await fs.rm(noteDir(id), { recursive: true, force: true });
    throw error;
  }
  return { count: created.length };
}
