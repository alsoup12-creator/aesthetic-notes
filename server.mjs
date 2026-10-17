import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, DATA, loadNotes, readNote, displayNote, saveNote, changeNote, assetBytes, referenceZip, backup, restore } from './lib/store.mjs';
import { listFolders, connectFolder, disconnectFolder, syncFolders } from './lib/folders.mjs';
import { skillInfo, skillPackage, SKILL_VERSION } from './lib/skill-package.mjs';

const port = Number(process.env.PORT || 4317);
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const origins = new Set([...hosts].map(h => `http://${h}`));
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/icon.svg', ['icon.svg', 'image/svg+xml']]]);
let mutations = Promise.resolve();
function exclusive(work) { const result = mutations.then(work); mutations = result.catch(() => {}); return result; }
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 200 * 1024 * 1024) { const error = new Error('本次导入超过 200 MB，请分批导入'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function download(res, bytes, name, type) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': bytes.length }); res.end(bytes);
}
let scan = null, lastScan = 0;
async function sync(force = false) {
  if (scan) return scan;
  if (!force && Date.now() - lastScan < 15000) return;
  scan = syncFolders();
  try { return await scan; } finally { lastScan = Date.now(); scan = null; }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (!hosts.has(req.headers.host)) return json(res, { error: '仅允许本机访问' }, 403);
  if (['POST', 'PATCH'].includes(req.method) && (req.headers['x-aesthetic-notes'] !== '1' || (req.headers.origin && !origins.has(req.headers.origin)))) return json(res, { error: '请求来源无效' }, 403);
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, type] = staticFiles.get(url.pathname);
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; frame-src 'self' blob:; object-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(await fs.readFile(path.join(ROOT, 'public', file)));
    }
    if (req.method === 'GET' && url.pathname === '/api/notes') { await sync(); return json(res, { notes: (await loadNotes()).map(displayNote) }); }
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, { version: SKILL_VERSION, dataPath: DATA });
    if (req.method === 'GET' && url.pathname === '/api/skill') return json(res, await skillInfo());
    if (req.method === 'GET' && url.pathname === '/api/skill/download') return download(res, await skillPackage(), 'aesthetic-notes-skill.zip', 'application/zip');
    if (req.method === 'GET' && url.pathname === '/api/folders') return json(res, { folders: await listFolders() });
    if (req.method === 'POST' && url.pathname === '/api/folders/pick') {
      if (process.platform !== 'win32') throw new Error('请粘贴文件夹的完整路径接入');
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/pick-folder.ps1')], { windowsHide: true, timeout: 300000, encoding: 'utf8' });
      return json(res, { path: stdout.trim() });
    }
    if (req.method === 'POST' && url.pathname === '/api/folders') {
      const input = JSON.parse((await body(req)).toString());
      return json(res, { folder: await exclusive(() => connectFolder(input.path)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/folders/sync') return json(res, await sync(true));
    const folderMatch = url.pathname.match(/^\/api\/folders\/([\da-f-]+)$/i);
    if (req.method === 'PATCH' && folderMatch) { await exclusive(() => disconnectFolder(folderMatch[1])); return json(res, { ok: true }); }
    const asset = url.pathname.match(/^\/assets\/([\da-f-]+)\/([\da-f-]+\.[a-z]+)$/i);
    if (req.method === 'GET' && asset) {
      const note = await readNote(asset[1]);
      const a = note.attachments.find(a => a.file === asset[2]);
      if (!a) return json(res, { error: '附件不存在' }, 404);
      const bytes = await assetBytes(note, a);
      res.writeHead(200, { 'Content-Type': a.type + (a.type === 'text/plain' ? '; charset=utf-8' : ''), 'Content-Length': bytes.length, ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}` } : {}) });
      return res.end(bytes);
    }
    if (req.method === 'POST' && url.pathname === '/api/notes') {
      const buffer = await body(req);
      const form = await new Request(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: buffer }).formData();
      const input = JSON.parse(form.get('note'));
      const files = form.getAll('files').filter(f => typeof f !== 'string');
      return json(res, { note: displayNote(await exclusive(() => saveNote(input, files, input.keptAttachments))) });
    }
    const match = url.pathname.match(/^\/api\/notes\/([\da-f-]+)$/i);
    if (req.method === 'PATCH' && match) {
      const change = JSON.parse((await body(req)).toString());
      return json(res, { note: await exclusive(() => changeNote(match[1], change)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/export') {
      const input = JSON.parse((await body(req)).toString());
      await sync(true);
      const bytes = await exclusive(() => referenceZip(input.ids, input.task));
      return download(res, bytes, 'aesthetic-references.zip', 'application/zip');
    }
    if (req.method === 'GET' && url.pathname === '/api/backup') {
      const bytes = Buffer.from(JSON.stringify(await exclusive(backup)));
      return download(res, bytes, `aesthetic-notes-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    }
    if (req.method === 'POST' && url.pathname === '/api/restore') {
      const input = JSON.parse((await body(req)).toString());
      return json(res, await exclusive(() => restore(input)));
    }
    json(res, { error: '没有找到这个页面' }, 404);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : (error.status || 400);
    json(res, { error: error.code === 'ENOENT' ? '笔记或附件不存在' : error.message }, status);
  }
});
const scanTimer = setInterval(() => sync().catch(error => console.error('文件夹同步暂未完成：' + error.message)), 20000);
scanTimer.unref();
server.listen(port, '127.0.0.1', () => console.log(`审美笔记 http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 正在使用。请打开 http://127.0.0.1:${port}，或设置 PORT 后重试。` : error.message); process.exitCode = 1; });
