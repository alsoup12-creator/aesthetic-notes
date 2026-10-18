import { createReadStream, promises as fs } from 'node:fs';

// Video players seek with byte ranges; do not buffer a whole recording in memory.
export async function sendFile(req, res, file, type, name) {
  const stat = await fs.stat(file), length = stat.size;
  let start = 0, end = length - 1, status = 200;
  const headers = { 'Content-Type': type + (/^(text\/|application\/json)/.test(type) ? '; charset=utf-8' : ''), 'Accept-Ranges': 'bytes' };
  if (name) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, length - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      status = 206;
    }
    if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${length}` }); return res.end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${length}`;
  }
  headers['Content-Length'] = length ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !length) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
