import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runtimeRevision } from '../lib/runtime-version.mjs';

const root = path.resolve(import.meta.dirname, '..');
const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
test('本地笔记的持久化、原件、备份恢复和参考包', async t => {
  const testRoot = path.join(root, '.runtime');
  await fs.mkdir(testRoot, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(testRoot, 'aesthetic-notes-test-'));
  const dataDir = path.join(scratch, 'store');
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), AESTHETIC_NOTES_DATA: dataDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    assert.ok(path.basename(scratch).startsWith('aesthetic-notes-test-'));
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`${base}/api/info`)).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, logs);
  const call = (route, options = {}) => fetch(base + route, { ...options, headers: { 'X-Aesthetic-Notes': '1', ...options.headers } });
  let id;
  await t.test('报告已加载的服务代码版本；浏览器拖放模块可直接加载', async () => {
    const info = await (await call('/api/info')).json();
    assert.equal(info.runtimeRevision, await runtimeRevision(root));
    const module = await call('/browser-drop.js');
    assert.equal(module.status, 200); assert.match(module.headers.get('content-type'), /text\/javascript/);
    assert.ok((await module.text()).includes('export function snapshotDrop'));
  });
  await t.test('拒绝跨站写入；页面无需外部依赖', async () => {
    assert.equal((await call('/api/restore', { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' })).status, 403);
    const page = await (await call('/')).text(); assert.ok(page.includes('审美笔记')); assert.ok(!page.includes('https://'));
  });
  await t.test('保存截图与点评、读取原始附件', async () => {
    const form = new FormData();
    form.set('note', JSON.stringify({ title: '测试：阅读与留白', comment: '喜欢层次，不参考颜色。', text: '第一行\n\n第二行', facets: ['视觉', '产品'], tags: ['中文阅读'], favorite: true }));
    form.append('files', new File([screenshot], '截图.png', { type: 'image/png' }));
    const response = await call('/api/notes', { method: 'POST', body: form }); assert.equal(response.status, 200);
    const { note } = await response.json(); id = note.id;
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'notes', id, 'note.json'), 'utf8'));
    assert.equal(saved.comment, '喜欢层次，不参考颜色。'); assert.equal(saved.text, '第一行\n\n第二行'); assert.deepEqual(saved.facets, ['视觉', '产品']);
    const bytes = Buffer.from(await (await call(`/assets/${id}/${note.attachments[0].file}`)).arrayBuffer()); assert.deepEqual(bytes, screenshot);
  });
  await t.test('编辑保留附件与上一版，支持回收和恢复', async () => {
    let notes = (await (await call('/api/notes')).json()).notes, note = notes[0];
    const form = new FormData(); form.set('note', JSON.stringify({ ...note, title: '修改后的标题', keptAttachments: note.attachments.map(a => a.id) }));
    const response = await call('/api/notes', { method: 'POST', body: form }); assert.equal(response.status, 200);
    assert.equal((await response.json()).note.attachments.length, 1);
    const previous = JSON.parse(await fs.readFile(path.join(dataDir, 'notes', id, 'note.previous.json'), 'utf8')); assert.equal(previous.title, '测试：阅读与留白');
    for (const trashed of [true, false]) {
      const result = await (await call(`/api/notes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed }) })).json(); assert.equal(result.note.trashed, trashed);
    }
  });
  await t.test('参考 ZIP 可由独立解压器打开，包含原件和原话', async () => {
    const response = await call('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], task: '制作阅读界面' }) }); assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer());
    const result = spawnSync('python', ['-c', 'import io,sys,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; m=json.loads(z.read("manifest.json")); assert m["task"]=="制作阅读界面"; n=m["notes"][0]; assert "喜欢层次，不参考颜色。" in z.read(n["id"]+"/note.md").decode(); assert z.read(n["id"]+"/assets/"+n["attachments"][0]["file"]).startswith(b"\\x89PNG"); print("ok")'], { input: zip, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ok');
  });
  await t.test('完整备份恢复为新副本；无效备份不会写入部分笔记', async () => {
    const payload = await (await call('/api/backup')).json(); assert.equal(payload.notes.length, 1); assert.equal(payload.notes[0].attachments[0].base64, screenshot.toString('base64'));
    const result = await (await call('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json(); assert.equal(result.count, 1);
    const notes = (await (await call('/api/notes')).json()).notes; assert.equal(notes.length, 2); assert.notEqual(notes[0].id, notes[1].id);
    assert.equal(notes.find(n => n.id === id).title, '修改后的标题');
    const bad = structuredClone(payload); bad.notes.push({ title: '坏附件', attachments: [{ name: 'bad.exe', base64: 'YQ==' }] });
    assert.equal((await call('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad) })).status, 400);
    assert.equal((await (await call('/api/notes')).json()).notes.length, 2);
  });
  await t.test('命令行无需网页也能读取原文与附件路径', async () => {
    const result = spawnSync(process.execPath, ['scripts/notes.mjs', 'show', id, '--json'], { cwd: root, env: { ...process.env, AESTHETIC_NOTES_DATA: dataDir }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); const note = JSON.parse(result.stdout); assert.equal(note.comment, '喜欢层次，不参考颜色。'); assert.ok(path.isAbsolute(note.attachments[0].absolutePath));
  });
  let connected, linked, originalDir;
  await t.test('已整理文件夹保留原结构与原话，重复检查不产生副本', async () => {
    originalDir = path.join(scratch, 'external-fixture');
    const group = path.join(originalDir, '阅读界面'); await fs.mkdir(group, { recursive: true });
    await fs.writeFile(path.join(group, '截图.png'), screenshot);
    await fs.writeFile(path.join(group, '我的说明.md'), '# 我的说明\n喜欢层次，颜色不用参考。\n\n原来的换行。', 'utf8');
    const response = await call('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: originalDir }) });
    assert.equal(response.status, 200); connected = (await response.json()).folder;
    let notes = (await (await call('/api/notes')).json()).notes;
    linked = notes.find(n => n.linkedSource?.connectionId === connected.id);
    assert.ok(linked); assert.equal(linked.title, '阅读界面'); assert.equal(linked.attachments.length, 2); assert.ok(linked.text.includes('颜色不用参考。\n\n原来的换行。'));
    assert.equal(linked.linkedSource.directory, group); assert.equal(linked.organizationState, 'pending');
    assert.deepEqual(await fs.readdir(group), ['截图.png', '我的说明.md'].sort());
    await call('/api/folders/sync', { method: 'POST' });
    notes = (await (await call('/api/notes')).json()).notes;
    assert.equal(notes.filter(n => n.linkedSource?.connectionId === connected.id).length, 1);
    assert.equal(notes.find(n => n.id === linked.id).revision, linked.revision);
    const image = linked.attachments.find(a => a.type === 'image/png');
    assert.deepEqual(Buffer.from(await (await call(`/assets/${linked.id}/${image.file}`)).arrayBuffer()), screenshot);
  });
  await t.test('Skill 统一读取和写入派生整理；原件变化拒绝旧理解', async () => {
    const run = args => spawnSync(process.execPath, ['scripts/notes.mjs', ...args], { cwd: root, env: { ...process.env, AESTHETIC_NOTES_DATA: dataDir }, encoding: 'utf8', windowsHide: true });
    let result = run(['show', linked.id, '--json']); assert.equal(result.status, 0, result.stderr);
    const full = JSON.parse(result.stdout); assert.ok(full.attachments.every(a => path.isAbsolute(a.absolutePath)));
    const organizationFile = path.join(scratch, 'organization.json');
    await fs.writeFile(organizationFile, JSON.stringify({ title: '有层次的阅读界面', facets: ['视觉', '产品'], tags: ['阅读层次'], summary: '用于验证整理写回。', preferenceInterpretation: '根据说明，仅参考层次。', evidence: '我的说明.md' }));
    result = run(['organize', linked.id, '--file', organizationFile, '--revision', full.revision]); assert.equal(result.status, 0, result.stderr);
    let notes = (await (await call('/api/notes')).json()).notes;
    assert.equal(notes.find(n => n.id === linked.id).organizationState, 'ready'); assert.equal(notes.find(n => n.id === linked.id).title, '有层次的阅读界面');
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'notes', linked.id, 'note.json'), 'utf8'));
    assert.equal(saved.comment, ''); assert.ok(saved.text.includes('喜欢层次，颜色不用参考。')); assert.equal(saved.title, '阅读界面');
    await fs.appendFile(path.join(originalDir, '阅读界面', '我的说明.md'), '\n新增了一句。');
    result = run(['organize', linked.id, '--file', organizationFile, '--revision', full.revision]); assert.equal(result.status, 1); assert.ok(result.stderr.includes('重新读取'));
    notes = (await (await call('/api/notes')).json()).notes;
    const changed = notes.find(n => n.id === linked.id); assert.equal(changed.organizationState, 'stale'); assert.ok(changed.text.includes('新增了一句。'));
  });
  await t.test('源文件消失、断开与备份不改动原目录', async () => {
    await fs.unlink(path.join(originalDir, '阅读界面', '截图.png'));
    await call('/api/folders/sync', { method: 'POST' });
    let notes = (await (await call('/api/notes')).json()).notes;
    assert.equal(notes.find(n => n.id === linked.id).attachments.length, 1);
    const payload = await (await call('/api/backup')).json(); assert.equal(payload.connectedFolders[0].path, originalDir); assert.ok(payload.notes.find(n => n.id === linked.id).attachments[0].base64);
    assert.equal((await call('/api/folders/' + connected.id, { method: 'PATCH' })).status, 200);
    notes = (await (await call('/api/notes')).json()).notes; assert.equal(notes.find(n => n.id === linked.id).linkedSource.status, 'detached');
    assert.ok((await fs.readFile(path.join(originalDir, '阅读界面', '我的说明.md'), 'utf8')).includes('新增了一句。'));
    const offlineBackup = await (await call('/api/backup')).json(); assert.equal(offlineBackup.notes.find(n => n.id === linked.id).attachments[0].unavailable, true);
  });
  await t.test('Skill 下载包完整、不含笔记，解压安装后可在其他目录读取关联库', async () => {
    const info = await (await call('/api/skill')).json(); assert.equal(info.version, '0.4.0');
    const response = await call('/api/skill/download'); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
    const zip = Buffer.from(await response.arrayBuffer());
    assert.ok(!zip.includes(Buffer.from('喜欢层次，不参考颜色。'))); assert.ok(!zip.includes(Buffer.from(root)));
    const unpacked = path.join(scratch, 'downloaded-package');
    const extracted = spawnSync('python', ['-c', 'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; names=z.namelist(); assert all(".." not in n.split("/") for n in names); assert "aesthetic-notes/runtime/scripts/notes.mjs" in names; assert "aesthetic-notes/scripts/library.json" not in names; assert not any("data/notes/" in n for n in names); z.extractall(sys.argv[1])', unpacked], { input: zip, encoding: 'utf8', windowsHide: true });
    assert.equal(extracted.status, 0, extracted.stderr);
    const codexHome = path.join(scratch, 'isolated-codex-home'), env = { ...process.env, CODEX_HOME: codexHome };
    const install = () => spawnSync(process.execPath, [path.join(unpacked, 'install.mjs'), '--quiet'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    let result = install(); assert.equal(result.status, 0, result.stderr);
    const installed = path.join(codexHome, 'skills', 'aesthetic-notes'), entry = path.join(installed, 'scripts', 'notes.mjs');
    assert.ok((await fs.stat(path.join(installed, 'runtime', 'lib', 'folders.mjs'))).isFile());
    const unrelated = path.join(scratch, 'another-project'); await fs.mkdir(unrelated);
    const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: unrelated, env, encoding: 'utf8', windowsHide: true });
    result = run(['list']); assert.equal(result.status, 1); assert.ok(result.stderr.includes('尚未关联'));
    const library = path.join(scratch, 'relocated-library'); await fs.mkdir(library); await fs.cp(dataDir, path.join(library, 'data'), { recursive: true });
    result = run(['configure', '--library', library]); assert.equal(result.status, 0, result.stderr);
    result = run(['list']); assert.equal(result.status, 0, result.stderr); assert.ok(JSON.parse(result.stdout).count >= 2);
    result = run(['show', id, '--json']); assert.equal(result.status, 0, result.stderr); const note = JSON.parse(result.stdout);
    assert.equal(note.comment, '喜欢层次，不参考颜色。'); assert.ok(note.attachments[0].absolutePath.startsWith(library));
    const before = await fs.readFile(path.join(installed, 'scripts', 'library.json'), 'utf8');
    result = install(); assert.equal(result.status, 0, result.stderr); assert.equal(await fs.readFile(path.join(installed, 'scripts', 'library.json'), 'utf8'), before);
  });
  let web;
  await t.test('网页与资源保留相对路径；预览在独立只读来源，不能读取笔记接口', async () => {
    const form = new FormData();
    form.set('note', JSON.stringify({ text: 'https://example.com/interaction\n喜欢展开时还保留原位置。', comment: '关注操作后的反馈。', filePaths: ['网页/index.html', '网页/assets/behavior.js', '网页/assets/style.css', '网页/assets/state.json'] }));
    for (const [name, content] of [['index.html', '<!doctype html><link rel="stylesheet" href="/assets/style.css"><button id="expand">展开</button><p id="feedback" hidden>已展开</p><script src="assets/behavior.js"></script>'], ['behavior.js', 'document.querySelector("#expand").onclick=()=>document.querySelector("#feedback").hidden=false'], ['style.css', 'button { color: green; }'], ['state.json', '{"label":"已展开"}']]) form.append('files', new File([content], name));
    let response = await call('/api/notes', { method: 'POST', body: form }); assert.equal(response.status, 200); web = (await response.json()).note;
    assert.deepEqual(web.links, ['https://example.com/interaction']); assert.equal(web.attachments[1].relativePath, '网页/assets/behavior.js');
    const html = web.attachments.find(a => a.type === 'text/html');
    response = await call(`/assets/${web.id}/${html.file}`); assert.ok(response.headers.get('content-disposition').startsWith('attachment;')); assert.ok(response.headers.get('content-security-policy').includes('sandbox;'));
    response = await call(`/api/preview/${web.id}/${html.file}`, { method: 'POST' }); assert.equal(response.status, 200);
    const preview = await response.json(), origin = new URL(preview.url).origin; assert.notEqual(origin, base);
    response = await fetch(preview.url); assert.equal(response.status, 200); assert.ok((await response.text()).includes('id="expand"'));
    const policy = response.headers.get('content-security-policy'); assert.ok(policy.includes('sandbox allow-scripts;')); assert.ok(!policy.includes('allow-same-origin')); assert.ok(policy.includes("form-action 'none'"));
    assert.equal((await fetch(origin + '/assets/style.css')).status, 200); assert.equal((await fetch(origin + '/assets/state.json')).status, 200);
    assert.equal((await fetch(origin + '/api/notes')).status, 404); assert.equal((await fetch(origin + '/assets/state.json', { method: 'POST' })).status, 403);
    assert.equal((await fetch(origin + '/%2e%2e%2fnote.json')).status, 404);
    const update = new FormData(); update.set('note', JSON.stringify({ id: web.id, comment: '更关注返回路径。' }));
    assert.equal((await call('/api/notes', { method: 'POST', body: update })).status, 200);
    const reopened = await (await call(`/api/preview/${web.id}/${html.file}`, { method: 'POST' })).json(); assert.equal(reopened.url, preview.url);
    assert.equal((await fetch(preview.url)).status, 200);
    const remove = new FormData(); remove.set('note', JSON.stringify({ id: web.id, keptAttachments: web.attachments.filter(a => a.type !== 'application/json').map(a => a.id) }));
    const removed = await call('/api/notes', { method: 'POST', body: remove }); assert.equal(removed.status, 200); web = (await removed.json()).note;
    assert.equal((await fetch(preview.url)).status, 409);
  });
  await t.test('网页参考包与备份恢复保持资源关系；拒绝越界资源路径且不产生记录', async () => {
    const response = await call('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [web.id] }) }); assert.equal(response.status, 200);
    const result = spawnSync('python', ['-c', 'import io,sys,json,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; n=json.loads(z.read("manifest.json"))["notes"][0]; root=n["id"]+"/assets/网页/"; assert "assets/behavior.js" in z.read(root+"index.html").decode(); assert "onclick" in z.read(root+"assets/behavior.js").decode(); assert root+"assets/style.css" in z.namelist()', ], { input: Buffer.from(await response.arrayBuffer()), encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr);
    const payload = await (await call('/api/backup')).json(); payload.notes = payload.notes.filter(n => n.id === web.id);
    assert.equal((await call('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 200);
    const notes = (await (await call('/api/notes')).json()).notes, restored = notes.find(n => n.id !== web.id && n.text === web.text); assert.ok(restored);
    assert.deepEqual(restored.attachments.map(a => a.relativePath), web.attachments.map(a => a.relativePath));
    const before = notes.length, form = new FormData(); form.set('note', JSON.stringify({ filePaths: ['../escape.html'] })); form.append('files', new File(['bad'], 'escape.html'));
    assert.equal((await call('/api/notes', { method: 'POST', body: form })).status, 400); assert.equal((await (await call('/api/notes')).json()).notes.length, before);
  });
  await t.test('录屏保存原始字节，支持播放进度所需的范围读取', async () => {
    const recording = Buffer.from('0123456789abcdefghijklmnop'), form = new FormData(); form.set('note', JSON.stringify({ comment: '观察折叠与恢复。' })); form.append('files', new File([recording], '操作录屏.webm'));
    const response = await call('/api/notes', { method: 'POST', body: form }); assert.equal(response.status, 200); const { note } = await response.json(), asset = note.attachments[0], url = `/assets/${note.id}/${asset.file}`; assert.equal(asset.type, 'video/webm');
    let range = await call(url, { headers: { Range: 'bytes=4-9' } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 4-9/${recording.length}`); assert.equal(await range.text(), '456789');
    range = await call(url, { headers: { Range: 'bytes=-3' } }); assert.equal(await range.text(), 'nop');
    assert.equal((await call(url, { headers: { Range: 'bytes=100-200' } })).status, 416);
    assert.deepEqual(Buffer.from(await (await call(url)).arrayBuffer()), recording);
  });
  await t.test('已有网页文件夹及资源子目录成为同一材料组，修改脚本使整理过期', async () => {
    const directory = path.join(scratch, 'saved-website'), assets = path.join(directory, 'assets'); await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(directory, 'index.htm'), '<script src="assets/app.js"></script>'); await fs.writeFile(path.join(assets, 'app.js'), 'const label="展开";'); await fs.writeFile(path.join(assets, 'style.css'), 'body{color:green}');
    const response = await call('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: directory }) }); assert.equal(response.status, 200); const connection = (await response.json()).folder;
    let notes = (await (await call('/api/notes')).json()).notes.filter(n => n.linkedSource?.connectionId === connection.id); assert.equal(notes.length, 1); const note = notes[0]; assert.equal(note.attachments.length, 3); assert.ok(note.attachments.some(a => a.relativePath === 'assets/app.js'));
    const organizationFile = path.join(scratch, 'web-organization.json'); await fs.writeFile(organizationFile, JSON.stringify({ title: '展开反馈', facets: ['产品'], tags: [], observations: '仅阅读代码，未实际操作。' }));
    const run = args => spawnSync(process.execPath, ['scripts/notes.mjs', ...args], { cwd: root, env: { ...process.env, AESTHETIC_NOTES_DATA: dataDir }, encoding: 'utf8', windowsHide: true });
    assert.equal(run(['organize', note.id, '--file', organizationFile, '--revision', note.revision]).status, 0);
    const html = note.attachments.find(a => a.type === 'text/html'), preview = await (await call(`/api/preview/${note.id}/${html.file}`, { method: 'POST' })).json();
    assert.equal((await fetch(new URL('assets/app.js', preview.url))).status, 200);
    await fs.appendFile(path.join(assets, 'app.js'), '\n// changed'); await call('/api/folders/sync', { method: 'POST' });
    notes = (await (await call('/api/notes')).json()).notes; assert.equal(notes.find(n => n.id === note.id).organizationState, 'stale'); assert.equal((await fetch(preview.url)).status, 409);
    assert.equal(await fs.readFile(path.join(directory, 'index.htm'), 'utf8'), '<script src="assets/app.js"></script>');
    const linkedForm = new FormData(); linkedForm.set('note', JSON.stringify({ id: note.id, keptAttachments: [] }));
    assert.equal((await call('/api/notes', { method: 'POST', body: linkedForm })).status, 400);
    assert.equal((await (await call('/api/notes')).json()).notes.find(n => n.id === note.id).attachments.length, 3);
  });
  await t.test('同一笔记追加和删除材料，保留文字标注并拒绝过期覆盖', async () => {
    const initial = new FormData(); initial.set('note', JSON.stringify({ text: '原始文字', comment: '喜欢线条，不参考颜色' }));
    initial.append('files', new File([screenshot], '图片.png'));
    let note = (await (await call('/api/notes', { method: 'POST', body: initial })).json()).note;
    const image = note.attachments[0];
    const extra = new FormData(); extra.set('note', JSON.stringify({ id: note.id, expectedRevision: note.revision, keptAttachments: [image.id] }));
    extra.append('files', new File(['<p>原始 HTML</p>'], '片段.html'));
    note = (await (await call('/api/notes', { method: 'POST', body: extra })).json()).note;
    assert.equal(note.attachments.length, 2); const beforeRemoval = note.revision;
    const remove = new FormData(); remove.set('note', JSON.stringify({ id: note.id, expectedRevision: beforeRemoval, keptAttachments: note.attachments.filter(a => a.id !== image.id).map(a => a.id) }));
    note = (await (await call('/api/notes', { method: 'POST', body: remove })).json()).note;
    assert.equal(note.attachments.length, 1); assert.equal(note.attachments[0].type, 'text/html');
    assert.equal(note.text, '原始文字'); assert.equal(note.comment, '喜欢线条，不参考颜色');
    const previous = JSON.parse(await fs.readFile(path.join(dataDir, 'notes', note.id, 'note.previous.json'), 'utf8'));
    assert.equal(previous.attachments.length, 2);
    assert.equal((await call('/api/notes', { method: 'POST', body: remove })).status, 400);
    const empty = new FormData(); empty.set('note', JSON.stringify({ id: note.id, expectedRevision: note.revision, keptAttachments: [] }));
    note = (await (await call('/api/notes', { method: 'POST', body: empty })).json()).note;
    assert.equal(note.attachments.length, 0); assert.equal(note.comment, '喜欢线条，不参考颜色');
  });
  await t.test('彻底删除只清理确认过的回收站记录，拒绝跨站、过期和正常笔记', async () => {
    const make = async title => {
      const form = new FormData(); form.set('note', JSON.stringify({ title })); form.append('files', new File([screenshot], '截图.png'));
      return (await (await call('/api/notes', { method: 'POST', body: form })).json()).note;
    };
    const active = await make('保留的正常笔记'); let first = await make('待清理一'), second = await make('待清理二');
    const trash = async note => (await (await call(`/api/notes/${note.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })).json()).note;
    first = await trash(first); second = await trash(second);
    const entry = note => ({ id: note.id, revision: note.revision, updatedAt: note.updatedAt });
    const purge = notes => call('/api/trash', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
    assert.equal((await fetch(base + '/api/trash', { method: 'DELETE', body: JSON.stringify({ notes: [entry(first)] }) })).status, 403);
    assert.equal((await call('/api/trash', { method: 'DELETE', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: [entry(first)] }) })).status, 403);
    assert.equal((await purge([entry(first), entry(active)])).status, 400);
    assert.ok(await fs.stat(path.join(dataDir, 'notes', first.id)));
    assert.equal((await purge([{ ...entry(first), revision: 'old' }])).status, 400);
    assert.equal((await purge([{ ...entry(first), updatedAt: 'old' }])).status, 400);
    const response = await purge([entry(first)]); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).deleted, [first.id]);
    await assert.rejects(fs.stat(path.join(dataDir, 'notes', first.id)), { code: 'ENOENT' });
    assert.ok(await fs.stat(path.join(dataDir, 'notes', second.id)));
    assert.ok(await fs.stat(path.join(dataDir, 'notes', active.id)));
  });
  await t.test('彻底删除文件夹引用保留源文件，后续同步不重新创建已清理组', async () => {
    const source = path.join(scratch, 'purged-reference'), group = path.join(source, '图片组');
    await fs.mkdir(group, { recursive: true }); await fs.writeFile(path.join(group, '原图.png'), screenshot);
    const connection = (await (await call('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: source }) })).json()).folder;
    let note = (await (await call('/api/notes')).json()).notes.find(n => n.linkedSource?.connectionId === connection.id);
    note = (await (await call(`/api/notes/${note.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })).json()).note;
    const response = await call('/api/trash', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: [{ id: note.id, revision: note.revision, updatedAt: note.updatedAt }] }) });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await fs.readFile(path.join(group, '原图.png'))), screenshot);
    await call('/api/folders/sync', { method: 'POST' });
    assert.equal((await (await call('/api/notes')).json()).notes.filter(n => n.linkedSource?.connectionId === connection.id).length, 0);
    const fresh = path.join(source, '新资料组'); await fs.mkdir(fresh); await fs.writeFile(path.join(fresh, '新增.txt'), '新材料仍会同步');
    await call('/api/folders/sync', { method: 'POST' });
    const remaining = (await (await call('/api/notes')).json()).notes.filter(n => n.linkedSource?.connectionId === connection.id);
    assert.equal(remaining.length, 1); assert.ok(remaining[0].text.includes('新材料仍会同步'));
  });
});
