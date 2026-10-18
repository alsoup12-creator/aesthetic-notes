import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const source = path.join(import.meta.dirname, 'aesthetic-notes');
const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.codex');
const destination = path.join(home, 'skills', 'aesthetic-notes');
const files = ['SKILL.md', 'agents/openai.yaml', 'references/organization.md', 'scripts/notes.mjs', 'skill-manifest.json', 'runtime/lib/store.mjs', 'runtime/lib/folders.mjs', 'runtime/lib/lock.mjs', 'runtime/lib/files.mjs', 'runtime/lib/preview.mjs', 'runtime/scripts/notes.mjs'];
try {
  for (const file of files) await fs.access(path.join(source, file));
  for (const file of files) {
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.copyFile(target, target + '.previous'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.copyFile(path.join(source, file), target);
  }
  if (!process.argv.includes('--quiet')) {
    console.log('Installed: ' + destination);
    console.log('Return to the Skill page in Aesthetic Notes, copy the usage instruction and send it to your agent.');
  }
} catch (error) { console.error('Installation failed: ' + error.message); process.exitCode = 1; }
