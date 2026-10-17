import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const config = path.join(import.meta.dirname, 'library.json');
const args = process.argv.slice(2);
try {
  if (args[0] === 'configure') {
    const position = args.indexOf('--library');
    const supplied = position >= 0 ? args[position + 1] : null;
    if (!supplied || !path.isAbsolute(supplied)) throw new Error('请用 configure --library "笔记工具文件夹的完整路径" 关联使用者自己的笔记库');
    const root = await fs.realpath(supplied);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('笔记库路径必须是文件夹');
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    const temporary = config + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ root }, null, 2)); await fs.rename(temporary, config);
    console.log(JSON.stringify({ configured: true, root }, null, 2));
  } else {
    let settings;
    try { settings = JSON.parse(await fs.readFile(config, 'utf8')); }
    catch { throw new Error('Skill 尚未关联笔记库。请使用审美笔记工具 Skill 页复制的使用指令，或运行 configure --library "笔记工具文件夹完整路径"'); }
    if (!settings.root || !path.isAbsolute(settings.root)) throw new Error('笔记库关联无效，请重新运行 configure');
    const root = await fs.realpath(settings.root);
    process.env.AESTHETIC_NOTES_DATA = path.join(root, 'data');
    const runtime = path.resolve(import.meta.dirname, '../runtime/scripts/notes.mjs');
    try { await fs.access(runtime); }
    catch { throw new Error('Skill 的读取工具不完整，请从审美笔记的 Skill 页重新下载完整安装包'); }
    await import(pathToFileURL(runtime).href);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
