import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, makeZip } from './store.mjs';

export const SKILL_VERSION = '0.4.0';
export const SKILL_FILES = [
  ['skills/aesthetic-notes/SKILL.md', 'aesthetic-notes/SKILL.md'],
  ['skills/aesthetic-notes/agents/openai.yaml', 'aesthetic-notes/agents/openai.yaml'],
  ['skills/aesthetic-notes/references/organization.md', 'aesthetic-notes/references/organization.md'],
  ['skills/aesthetic-notes/scripts/notes.mjs', 'aesthetic-notes/scripts/notes.mjs'],
  ['lib/store.mjs', 'aesthetic-notes/runtime/lib/store.mjs'],
  ['lib/folders.mjs', 'aesthetic-notes/runtime/lib/folders.mjs'],
  ['lib/lock.mjs', 'aesthetic-notes/runtime/lib/lock.mjs'],
  ['lib/files.mjs', 'aesthetic-notes/runtime/lib/files.mjs'],
  ['lib/preview.mjs', 'aesthetic-notes/runtime/lib/preview.mjs'],
  ['scripts/notes.mjs', 'aesthetic-notes/runtime/scripts/notes.mjs'],
  ['scripts/install-downloaded-skill.mjs', 'install.mjs']
];
export async function skillPackage() {
  const entries = [];
  for (const [source, target] of SKILL_FILES) entries.push([target, await fs.readFile(path.join(ROOT, source))]);
  entries.push(['aesthetic-notes/skill-manifest.json', JSON.stringify({ name: 'aesthetic-notes', version: SKILL_VERSION }, null, 2)]);
  entries.push(['安装到Codex.cmd', '@echo off\r\nchcp 65001 >nul\r\nnode "%~dp0install.mjs"\r\npause\r\n']);
  entries.push(['开始使用.md', '# 审美笔记 Skill\n\n1. 将整个 ZIP 解压到一个文件夹。\n2. Windows 用户双击“安装到Codex.cmd”，安装到本机 Codex 的 skills 目录。已有的笔记库关联会保留。\n3. 回到审美笔记工具的“Skill”页，复制使用指令，交给 Agent。Agent 会使用包内配置命令关联你自己的笔记库。\n\n也可以把 aesthetic-notes 整个文件夹放入其他 Agent 支持的本地 Skill 目录。需要 Node.js 22 或以上版本，以及允许读取本机文件、运行脚本的 Agent。\n\n安装包包含完整读取与整理写回工具，不需要联网下载依赖，不包含任何笔记、个人路径、账号或密钥。下载包本身不会自动连接你的笔记库，也不会自动运行 AI。\n\n首次关联命令：node <Skill路径>/scripts/notes.mjs configure --library "你的审美笔记工具文件夹"\n\n之后用同一个脚本运行 list、pending、show、connect、sync、organize 等命令。工具网页可以关闭，Agent 仍可直接读取本机资料。云端 Agent 不能直接读取另一台电脑上的本地文件；这类场景请在工具中导出参考包交付。\n']);
  return makeZip(entries);
}
export async function skillInfo() {
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.codex');
  const installedPath = path.join(home, 'skills', 'aesthetic-notes');
  let installed = false, installedVersion = null, libraryRoot = null;
  try { await fs.access(path.join(installedPath, 'SKILL.md')); installed = true; } catch {}
  try { installedVersion = JSON.parse(await fs.readFile(path.join(installedPath, 'skill-manifest.json'), 'utf8')).version; } catch {}
  try { libraryRoot = JSON.parse(await fs.readFile(path.join(installedPath, 'scripts', 'library.json'), 'utf8')).root; } catch {}
  const normalize = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
  return { name: 'aesthetic-notes', version: SKILL_VERSION, installed, installedVersion, installedPath, libraryRoot: ROOT,
    linked: typeof libraryRoot === 'string' && normalize(libraryRoot) === normalize(ROOT) };
}
