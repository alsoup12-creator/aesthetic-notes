import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { imageTarget, remoteImage, publicAddress } from '../lib/remote-image.mjs';
import { imageFile } from '../public/browser-drop.js';

const resolve = async () => [{ address: '93.184.215.14', family: 4 }];
test('浏览器内嵌图片直接转为本地文件，不发起网络请求', async () => {
  const file = await imageFile('data:image/png;base64,aW1hZ2UgYnl0ZXM=', 0, () => assert.fail('内嵌图片不应联网'));
  assert.equal(file.type, 'image/png'); assert.equal(await file.text(), 'image bytes');
  const svg = await imageFile('data:image/svg+xml,%3Csvg%3E%E4%B8%AD%E6%96%87%3C%2Fsvg%3E', 1);
  assert.equal(await svg.text(), '<svg>中文</svg>');
});
test('网络图片只访问公开地址，拒绝地址变体及混合 DNS 结果', async () => {
  for (const url of ['file:///a.png', 'http://127.0.0.1/a.png', 'http://2130706433/a.png', 'http://10.0.0.1/a.png', 'http://169.254.169.254/a.png', 'http://[::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png', 'http://[fc00::1]/a.png', 'http://site.test:4317/a.png', 'https://user:secret@site.test/a.png']) {
    await assert.rejects(imageTarget(url, resolve));
  }
  await assert.rejects(imageTarget('https://site.test/a.png', async () => [...await resolve(), { address: '192.168.1.2', family: 4 }]));
  assert.equal((await imageTarget('https://site.test/a.png', resolve)).address.address, '93.184.215.14');
  assert.equal(publicAddress('2001:df2:e500:ed1a::2:b'), true);
  assert.equal(publicAddress('2001:db8::1'), false);
  assert.equal(publicAddress('2001::c000:201'), false);
  assert.equal(publicAddress('2002:7f00:1::1'), false);
});

function transport(responses, seen) {
  return (url, options, callback) => {
    seen.push(url.href);
    options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.215.14', family: 4 }]); });
    const request = new EventEmitter();
    request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
    process.nextTick(() => {
      const definition = responses.shift(), response = Readable.from([Buffer.from(definition.body || 'image bytes')]);
      response.statusCode = definition.status || 200; response.headers = definition.headers || { 'content-type': 'image/png' };
      response.on('close', () => request.emit('close')); callback(response);
    });
    return request;
  };
}
test('取得图片字节；每次重定向重新检查地址，普通网页和过大响应不作为图片', async () => {
  const seen = [], image = await remoteImage('https://site.test/picture', { resolve, get: transport([{ body: 'original bytes' }], seen) });
  assert.equal(image.type, 'image/png'); assert.equal(image.bytes.toString(), 'original bytes');
  await assert.rejects(remoteImage('https://site.test/picture', { resolve, get: transport([{ status: 302, headers: { location: 'http://127.0.0.1/private' } }], seen) }), /地址/);
  assert.equal(seen.filter(url => url.includes('127.0.0.1')).length, 0);
  await assert.rejects(remoteImage('https://site.test/page', { resolve, get: transport([{ headers: { 'content-type': 'text/html' } }], []) }), /无法直接读取/);
  await assert.rejects(remoteImage('https://site.test/large', { resolve, get: transport([{ headers: { 'content-type': 'image/png', 'content-length': '999999999' } }], []) }), /40 MB/);
});
