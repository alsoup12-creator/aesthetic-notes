const MAX_HTML = 2 * 1024 * 1024;
const allowedImage = /^data:image\/(png|jpeg|webp|gif|avif|svg\+xml)[;,]/i;

function webUrl(value, base) {
  try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

// Read strings and file entries synchronously inside the drop event: browsers
// revoke access to the drag data store once the handler yields.
export function snapshotDrop(transfer) {
  const items = [...(transfer.items || [])];
  return {
    files: [...transfer.files], entries: items.filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.()).filter(Boolean),
    html: transfer.getData('text/html'), plain: transfer.getData('text/plain'),
    uris: transfer.getData('text/uri-list'), moz: transfer.getData('text/x-moz-url')
  };
}

export function browserMaterial({ html = '', plain = '', uris = '', moz = '' }) {
  if (html.length > MAX_HTML) throw new Error('拖入的网页片段较大，请保存为 HTML 文件后导入');
  // Template content stays inert: parsing must not load images or apply styles
  // from the source page inside the notebook's own document.
  const template = document.createElement('template'); template.innerHTML = html;
  const fragment = template.content;
  const source = webUrl(html.match(/<!--\s*SourceURL:\s*([^\r\n<>]+?)(?:\s*-->|[\r\n])/i)?.[1]?.trim() || '') || webUrl(moz.split(/\r?\n/)[0]);
  const links = [...new Set(uris.split(/\r?\n/).filter(s => s.trim() && !s.startsWith('#')).map(s => webUrl(s.trim())).filter(Boolean))];
  if (!links.length && webUrl(plain.trim())) links.push(webUrl(plain.trim()));
  const base = source || webUrl(fragment.querySelector('base[href]')?.getAttribute('href') || '') || links[0];
  const images = [...new Set([...fragment.querySelectorAll('img')].map(img => {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    return allowedImage.test(src) ? src : webUrl(src, base);
  }).filter(Boolean))];
  // A URL alone may be an image or an ordinary link. The receiver checks its
  // response type; ordinary pages stay links rather than being scraped.
  const candidates = images.length ? images : !html ? (allowedImage.test(plain.trim()) ? [plain.trim()] : links) : [];
  const content = fragment.cloneNode(true);
  content.querySelectorAll('script,style,template,noscript').forEach(node => node.remove());
  content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  content.querySelectorAll('p,div,li,h1,h2,h3,h4,blockquote').forEach(node => node.append('\n'));
  const text = (plain.trim() || content.textContent.trim()).slice(0, 450000);
  const references = [...new Set([source, ...links, ...images.filter(s => !s.startsWith('data:'))].filter(Boolean))];
  const extra = references.filter(link => !text.includes(link));
  return { html, text: [text, extra.length ? (text ? '拖入时附带的链接：\n' : '') + extra.join('\n') : ''].filter(Boolean).join('\n\n'),
    images: candidates.slice(0, 12), explicitImages: images.length > 0 || allowedImage.test(plain.trim()), omitted: Math.max(0, candidates.length - 12) };
}

export async function imageFile(url, index, request) {
  let blob;
  if (allowedImage.test(url)) {
    if (url.length > 56 * 1048576) throw new Error('网络图片超过 40 MB');
    const comma = url.indexOf(','), metadata = url.slice(5, comma), encoded = url.slice(comma + 1);
    const bytes = /;base64(?:;|$)/i.test(metadata) ? Uint8Array.from(atob(encoded), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(encoded));
    blob = new Blob([bytes], { type: metadata.split(';')[0].toLowerCase() });
  } else {
    const response = await request('/api/import-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    blob = await response.blob();
  }
  if (blob.size > 40 * 1048576) throw new Error('网络图片超过 40 MB');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' }[blob.type.split(';')[0]];
  if (!extension) throw new Error('未取得支持的图片文件');
  return new File([blob], `网页图片-${Date.now()}-${index + 1}.${extension}`, { type: blob.type });
}
