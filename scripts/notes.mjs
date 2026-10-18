import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadNotes, readNote, displayNote, noteDir, assetPath, markdown, referenceZip, organizeNote, assetRelativePath } from '../lib/store.mjs';
import { syncFolders, connectFolder, listFolders } from '../lib/folders.mjs';

const args = process.argv.slice(2), command = args.shift() || 'list';
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
try {
  if (command === 'connect') console.log(JSON.stringify(await connectFolder(args[0]), null, 2));
  else if (command === 'folders') console.log(JSON.stringify(await listFolders(), null, 2));
  else if (command === 'sync') console.log(JSON.stringify(await syncFolders(), null, 2));
  else if (['list', 'pending'].includes(command)) {
    await syncFolders();
    let notes = (await loadNotes()).filter(n => !n.trashed).map(displayNote);
    const query = option('--query'), facet = option('--facet');
    if (command === 'pending') notes = notes.filter(n => n.organizationState !== 'ready');
    if (facet) notes = notes.filter(n => n.facets.includes(facet));
    if (query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      notes = notes.filter(n => terms.every(t => [n.title, n.comment, n.text, n.source, n.organization?.summary, ...n.tags, ...n.facets, n.linkedSource?.directory].join('\n').toLowerCase().includes(t)));
    }
    console.log(JSON.stringify({ count: notes.length, notes: notes.map(n => ({ id: n.id, revision: n.revision, title: n.title, organizationState: n.organizationState, facets: n.facets, tags: n.tags, comment: n.comment,
      textPreview: n.text.slice(0, 700), links: n.links, summary: n.organizationState === 'ready' ? n.organization?.summary : undefined,
      linkedSource: n.linkedSource, createdAt: n.createdAt, attachments: n.attachments.map(a => ({ id: a.id, name: a.name, type: a.type })), directory: noteDir(n.id) })) }, null, 2));
  } else if (command === 'show') {
    await syncFolders();
    const n = await readNote(args[0]);
    if (args.includes('--json')) {
      const attachments = [];
      for (const a of n.attachments) {
        try { attachments.push({ ...a, absolutePath: await assetPath(n, a) }); }
        catch (error) { attachments.push({ ...a, unavailable: true, error: error.message }); }
      }
      console.log(JSON.stringify({ ...displayNote(n), attachments }, null, 2));
    } else console.log(markdown(n, true));
  } else if (command === 'preview') {
    await syncFolders();
    const note = await readNote(args[0]), file = option('--file');
    if (note.trashed || (note.linkedSource && note.linkedSource.status !== 'available')) throw new Error('原件暂不可用');
    const html = note.attachments.find(a => a.type === 'text/html' && (!file || [a.id, a.file, assetRelativePath(a)].includes(file)));
    if (!html) throw new Error('没有找到 HTML，请用 --file 指定 show 返回的 file 或 relativePath');
    const { startPreview } = await import('../lib/preview.mjs');
    const preview = await startPreview(note);
    console.log(JSON.stringify({ url: preview.url(html), entry: assetRelativePath(html), revision: note.revision, message: '预览只读；保留此进程供浏览器体验，结束时停止进程。' }, null, 2));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { preview.close(); process.exit(); });
  } else if (command === 'organize') {
    if (!option('--file') || !option('--revision')) throw new Error('请指定 --file 整理结果.json 与 --revision 读取时的版本');
    await syncFolders();
    const result = JSON.parse(await fs.readFile(path.resolve(option('--file')), 'utf8'));
    console.log(JSON.stringify(await organizeNote(args[0], option('--revision'), result), null, 2));
  } else if (command === 'export') {
    await syncFolders();
    const ids = option('--ids')?.split(',').filter(Boolean), output = option('--output');
    if (!output) throw new Error('请用 --output 指定输出 ZIP 路径');
    const destination = path.resolve(output); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await referenceZip(ids, option('--task')), { flag: 'wx' });
    console.log(destination);
  } else throw new Error('可用命令：list / pending / show 编号 --json / preview 编号 --file 网页路径 / connect 文件夹路径 / folders / sync / organize 编号 --file 结果.json --revision 版本 / export --ids 编号 --output 输出.zip');
} catch (error) { console.error(error.message); process.exitCode = 1; }
