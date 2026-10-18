import http from 'node:http';
import { once } from 'node:events';
import { readNote, assetPath, assetRelativePath } from './store.mjs';
import { sendFile } from './files.mjs';

const signature = note => JSON.stringify(note.attachments.map(a => [a.id, a.file, a.relativePath, a.size, a.mtimeMs]));

// A separate, read-only origin has no notebook APIs. Sandbox stays in force
// even when an Agent opens the preview URL as a top-level browser page.
export async function startPreview(note) {
  const paths = note.attachments.map(assetRelativePath), root = (paths[0]?.split('/').slice(0, -1) || []);
  while (root.length && !paths.every(p => p.startsWith(root.join('/') + '/'))) root.pop();
  const prefix = root.length ? root.join('/') + '/' : '';
  const resourceName = a => assetRelativePath(a).slice(prefix.length);
  const resources = new Map(note.attachments.map(a => [resourceName(a), a]));
  const originalSignature = signature(note);
  let origin, lastUsed = Date.now();
  const server = http.createServer(async (req, res) => {
    lastUsed = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.origin === 'null' || req.headers.origin === origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline' ${origin}; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} blob:; connect-src ${origin}; base-uri ${origin}; form-action 'none'; frame-ancestors http://127.0.0.1:* http://localhost:*`);
    try {
      if (req.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(req.method) || (req.headers.origin && !['null', origin].includes(req.headers.origin))) { res.writeHead(403); return res.end('只读网页预览'); }
      const pathname = decodeURIComponent(new URL(req.url, origin).pathname).slice(1);
      const asset = resources.get(pathname);
      if (!asset) { res.writeHead(404); return res.end('未收录这份网页资源。请连同 HTML 的资源文件夹一起导入。'); }
      const current = await readNote(note.id);
      if (signature(current) !== originalSignature || current.trashed || (current.linkedSource && current.linkedSource.status !== 'available')) { res.writeHead(409); return res.end('材料已经变化，请重新打开预览。'); }
      await sendFile(req, res, await assetPath(current, asset), asset.type);
    } catch { if (!res.headersSent) res.writeHead(404); res.end('资源暂不可用，请重新打开预览。'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setInterval(() => { if (Date.now() - lastUsed > 20 * 60 * 1000) close(); }, 60000); timer.unref();
  function close() { clearInterval(timer); server.close(); server.closeAllConnections(); }
  return { origin, revision: note.revision, signature: originalSignature, close, get active() { return server.listening; },
    url: asset => origin + '/' + resourceName(asset).split('/').map(encodeURIComponent).join('/') };
}

const previews = new Map();
export async function previewFor(note, file) {
  const asset = note.attachments.find(a => a.file === file);
  if (!asset || asset.type !== 'text/html') throw new Error('请选择 HTML 网页原件');
  if (note.trashed || (note.linkedSource && note.linkedSource.status !== 'available')) throw new Error('原件暂不可用');
  let preview = previews.get(note.id);
  if (!preview?.active || preview.signature !== signature(note)) {
    if (preview) preview.close();
    if (previews.size >= 8) { const key = previews.keys().next().value; previews.get(key).close(); previews.delete(key); }
    preview = await startPreview(note); previews.set(note.id, preview);
  }
  return { url: preview.url(asset), entry: assetRelativePath(asset), revision: note.revision };
}
