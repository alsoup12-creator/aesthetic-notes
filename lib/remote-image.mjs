import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_IMAGE = 40 * 1024 * 1024;
const extensions = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/avif', 'avif'], ['image/svg+xml', 'svg']]);

// This endpoint receives untrusted URLs from drag data. Pin the validated DNS
// result for each hop so redirects and DNS rebinding cannot reach local services.
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19].includes(b)));
  }
  // Only ordinary global unicast IPv6; excludes mapped IPv4, ULA, link-local,
  // NAT64 and transition ranges which could tunnel requests to private IPv4.
  if (isIP(address) !== 6 || !/^[23]/i.test(address) || /^2002:/i.test(address)) return false;
  const [first, second] = address.split(':').map(part => parseInt(part || '0', 16));
  return !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}

export async function imageTarget(value, resolve = lookup) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('只支持普通 HTTP 或 HTTPS 图片地址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('不能从这个地址读取网络图片');
  return { url, address: addresses.find(a => a.family === 4) || addresses[0] };
}

export async function remoteImage(value, { resolve = lookup, get } = {}) {
  const deadline = Date.now() + 15000;
  for (let hop = 0; hop <= 4; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('读取图片超时');
    let dnsTimer;
    const { url, address } = await Promise.race([
      imageTarget(value, resolve),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('读取图片超时')), remaining); dnsTimer.unref(); })
    ]).finally(() => clearTimeout(dnsTimer));
    const result = await new Promise((resolve, reject) => {
      const request = (get || (url.protocol === 'https:' ? https : http).get)(url, {
        agent: false, family: address.family,
        lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
        headers: { Accept: 'image/*', 'Accept-Encoding': 'identity', 'User-Agent': 'AestheticNotes/0.3' }
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.destroy(); resolve({ redirect: new URL(response.headers.location, url).href }); return;
        }
        const type = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (response.statusCode !== 200 || !extensions.has(type)) {
          response.destroy(); reject(new Error('图片无法直接读取，可能需要登录或网站限制了下载')); return;
        }
        if (Number(response.headers['content-length']) > MAX_IMAGE) { response.destroy(); reject(new Error('网络图片超过 40 MB')); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_IMAGE) request.destroy(new Error('网络图片超过 40 MB'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => size ? resolve({ bytes: Buffer.concat(chunks), type, extension: extensions.get(type) }) : reject(new Error('图片内容为空')));
      });
      const timer = setTimeout(() => request.destroy(new Error('读取图片超时')), Math.max(1, deadline - Date.now()));
      request.on('close', () => clearTimeout(timer)); request.on('error', reject);
    });
    if (!result.redirect) return result;
    value = result.redirect;
  }
  throw new Error('图片重定向次数过多');
}
