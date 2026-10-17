const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { notes: [], view: 'all', query: '', tag: '', sort: 'newest', selecting: false, selected: new Set(), editing: null, files: [], kept: [], previewUrls: [], detailId: null, materialIndex: 0, version: 0, savedVersion: 0, saving: null, dirty: false };
const viewNames = { all: '全部笔记', favorite: '特别喜欢', 视觉: '视觉与排版', 文字: '文字与表达', 产品: '产品与体验', trash: '回收站' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const assetUrl = (n, a) => `/assets/${n.id}/${a.file}`;
const date = value => new Date(value).toLocaleDateString('zh-CN').replaceAll('/', '.');
const size = n => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const unavailable = n => n.linkedSource && n.linkedSource.status !== 'available';
const organizationLabel = n => ({ ready: 'Agent 已整理', stale: '有更新，待 Agent 阅读', pending: '已记录' }[n.organizationState] || '已记录');
let toastTimer, saveTimer, lastNotes = '';
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').hidden = false; $('#toast').classList.toggle('toast-error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 6500 : 3000);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'X-Aesthetic-Notes': '1', ...options.headers } });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '操作暂未完成，请稍后重试'); }
  return response;
}
async function refresh(force = false) {
  try {
    const data = await (await api('/api/notes')).json();
    const serialized = JSON.stringify(data.notes);
    if (force || serialized !== lastNotes) { state.notes = data.notes; lastNotes = serialized; render(); }
    $('#load-error').hidden = true;
  } catch (error) { $('#load-error').textContent = `暂时无法读取笔记：${error.message}。请确认本机应用正在运行。`; $('#load-error').hidden = false; }
}
function visibleNotes() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  return state.notes.filter(n => {
    if (state.view === 'trash' ? !n.trashed : n.trashed) return false;
    if (state.view === 'favorite' && !n.favorite) return false;
    if (['视觉', '文字', '产品'].includes(state.view) && !n.facets.includes(state.view)) return false;
    if (state.tag && !n.tags.includes(state.tag)) return false;
    const text = [n.title, n.comment, n.text, n.source, n.organizationState === 'ready' ? n.organization?.summary : '', n.linkedSource?.directory, ...n.tags, ...n.attachments.map(a => a.name)].join('\n').toLowerCase();
    return terms.every(t => text.includes(t));
  }).sort((a, b) => state.sort === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : state.sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt));
}
function render() {
  const active = state.notes.filter(n => !n.trashed);
  $('#count-all').textContent = active.length; $('#count-favorite').textContent = active.filter(n => n.favorite).length;
  for (const [id, facet] of [['visual', '视觉'], ['text', '文字'], ['product', '产品']]) $(`#count-${id}`).textContent = active.filter(n => n.facets.includes(facet)).length;
  $('#count-trash').textContent = state.notes.filter(n => n.trashed).length;
  $$('.nav-item[data-view]').forEach(e => e.classList.toggle('active', e.dataset.view === state.view));
  $('#view-crumb').textContent = viewNames[state.view]; $('#view-title').firstChild.textContent = state.view === 'all' ? '我的审美笔记' : viewNames[state.view];
  $('#view-description').textContent = state.view === 'trash' ? '原件和标注仍然保留，可以随时恢复。' : '传材料，写标注。其余交给 Agent。';
  const tags = [...new Set(active.flatMap(n => n.tags))].slice(0, 7); if (state.tag && !tags.includes(state.tag)) tags.push(state.tag);
  $('#tag-filters').innerHTML = `<button class="tag-filter ${!state.tag ? 'active' : ''}" data-tag="">所有标签</button>` + tags.map(t => `<button class="tag-filter ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
  const notes = visibleNotes(); $('#heading-count').textContent = notes.length; $('#visible-count').textContent = notes.length ? `${notes.length} 则记录` : '';
  $('#notes-grid').innerHTML = notes.map(n => {
    const image = !unavailable(n) && n.attachments.find(a => a.type.startsWith('image/'));
    const cover = image ? `<img class="card-image" src="${assetUrl(n, image)}" alt="${esc(n.title)}的原件" loading="lazy">` : unavailable(n) ? `<div class="card-file">${icon('file')}<span>原文件夹${n.linkedSource.status === 'detached' ? '已断开' : '暂不可用'}</span></div>` : n.text ? `<div class="card-original">${esc(n.text.slice(0, 300))}</div>` : n.attachments.length ? `<div class="card-file">${icon('file')}<span>原始材料 · ${n.attachments.length} 份</span></div>` : '';
    return `<article class="note-card ${state.selected.has(n.id) ? 'selected' : ''}">${state.selecting ? `<input class="card-select" type="checkbox" data-select="${n.id}" aria-label="选择 ${esc(n.title)}" ${state.selected.has(n.id) ? 'checked' : ''}>` : ''}<button class="card-open" data-open="${n.id}" aria-label="查看 ${esc(n.title)}">${cover}<div class="card-content"><div class="card-facets">${icon(n.linkedSource ? 'product' : 'book')}<span>${n.linkedSource ? '原文件夹' : '随手记录'} · ${organizationLabel(n)}</span></div><h2 class="card-title">${esc(n.title)}</h2><p class="card-comment">${esc(n.comment || (n.organizationState === 'ready' && n.organization?.summary) || '先留住这份喜欢，感受可以慢慢写。')}</p><div class="card-meta"><span class="card-tag">${esc(n.tags.map(t => '#' + t).join(' '))}</span><span>${date(n.createdAt)}</span></div></div></button>${!state.selecting && !n.trashed ? `<button class="card-favorite ${n.favorite ? 'on' : ''}" data-favorite="${n.id}" aria-label="${n.favorite ? '取消特别喜欢' : '标为特别喜欢'}" aria-pressed="${n.favorite}">${icon('star')}</button>` : ''}</article>`;
  }).join('');
  $('#empty-state').hidden = notes.length > 0;
  const first = !active.length && state.view !== 'trash' && !state.query && !state.tag;
  $('.empty-art').hidden = !first; $('.empty-kicker').hidden = !first;
  $('#empty-title').textContent = first ? '把让你停留的东西，留在这里。' : state.view === 'trash' ? '回收站是空的。' : '这里还没有对应的笔记。';
  $('#empty-description').innerHTML = first ? '放一张截图，粘贴一段文字，写几句自己的感受。<br>也可以直接接入你已经整理好的文件夹。' : state.query || state.tag ? '试试其他关键词，或取消筛选。' : '收集先发生，整理交给 Agent。';
  $('#empty-add').hidden = !first; $('#paste-tip').hidden = !first;
  $('#select-mode').hidden = state.view === 'trash' || !active.length; $('#select-mode').textContent = state.selecting ? '退出选择' : '选择笔记';
  $('#selection-bar').hidden = !state.selecting; $('#selected-count').textContent = `已选择 ${state.selected.size} 条`; $('#export-selected').disabled = !state.selected.size;
}
function endSelection() { state.selecting = false; state.selected.clear(); render(); }
function clearPreviews() { for (const u of state.previewUrls) URL.revokeObjectURL(u); state.previewUrls = []; }
function openEditor(note = null, files = [], text = '') {
  if ($('#editor').open) return;
  state.editing = note; state.files = []; state.kept = note ? [...note.attachments] : []; state.version = 0; state.savedVersion = 0; state.dirty = false;
  $('#note-comment').value = note?.comment || ''; $('#material-text').value = note?.text || text;
  $('#material-text').readOnly = Boolean(note?.linkedSource); $('#upload-zone').hidden = Boolean(note?.linkedSource);
  $('#linked-hint').hidden = !note?.linkedSource; $('#linked-hint').textContent = note?.linkedSource ? `来自 ${note.linkedSource.directory}。材料在原文件夹维护，在这里写下你的标注。` : '';
  $('#save-status').textContent = note ? '已保存在本机' : '传材料，写标注，就够了。';
  $('#detail').close(); $('#editor').showModal(); renderAttachments();
  if (files.length) addFiles(files); if (text) changed(); if (note) $('#note-comment').focus(); else $('#material-text').focus();
}
function changed(immediate = false) {
  state.version++; state.dirty = true; $('#save-status').textContent = '正在记下…';
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flushSave().catch(() => {}), immediate ? 0 : 650);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (state.saving) { await state.saving; return flushSave(); }
  if (state.version === state.savedVersion) return;
  if (!state.editing && !state.files.length && !$('#material-text').value.trim() && !$('#note-comment').value.trim()) { state.savedVersion = state.version; state.dirty = false; $('#save-status').textContent = '传材料，写标注，就够了。'; return; }
  const version = state.version, files = [...state.files];
  const input = { ...(state.editing ? { id: state.editing.id, expectedRevision: state.editing.revision } : {}), comment: $('#note-comment').value,
    ...(!state.editing?.linkedSource ? { text: $('#material-text').value } : {}), keptAttachments: state.kept.map(a => a.id) };
  const form = new FormData(); form.append('note', JSON.stringify(input)); files.forEach(f => form.append('files', f));
  state.saving = (async () => {
    $('#save-status').textContent = '正在保存…'; renderAttachments();
    try {
      const { note } = await (await api('/api/notes', { method: 'POST', body: form })).json();
      if (!note.linkedSource && $('#material-text').value === input.text && note.text !== input.text) $('#material-text').value = note.text;
      state.editing = note; state.kept = note.attachments; state.files = state.files.filter(f => !files.includes(f)); state.savedVersion = version;
      state.dirty = state.version !== version; $('#save-status').textContent = state.dirty ? '正在记下…' : '已自动保存在本机';
      await refresh();
    } catch (error) { $('#save-status').textContent = '尚未保存，点击这里重试'; toast(`保存未完成：${error.message}`, true); throw error; }
    finally { state.saving = null; renderAttachments(); }
  })();
  await state.saving;
  if (state.version !== state.savedVersion) return flushSave();
}
async function closeEditor() {
  try { await flushSave(); $('#editor').close(); clearPreviews(); state.files = []; state.dirty = false; }
  catch { $('#note-comment').focus(); }
}
function addFiles(files) {
  if (state.editing?.linkedSource) return toast('这份材料在原文件夹维护，可以在这里补充标注。');
  for (const f of files) {
    if (!/\.(png|jpe?g|webp|gif|avif|pdf|txt|md)$/i.test(f.name)) { toast(`暂不支持 ${f.name}，请放入图片、PDF 或文字`, true); continue; }
    if (f.size > 40 * 1048576) { toast('单个文件请控制在 40 MB 以内', true); continue; }
    if (state.files.length + state.kept.length >= 40) { toast('一则记录最多支持 40 个附件', true); break; }
    state.files.push(f);
  }
  renderAttachments(); changed(true);
}
function pdfPreview(name, url) { return `<div class="pdf-preview">${icon('file')}<strong>${esc(name)}</strong><span>保留完整 PDF 原件</span><a href="${url}" download="${esc(name)}">下载原件查看</a><small>使用本机 PDF 阅读器打开</small></div>`; }
function renderAttachments() {
  clearPreviews();
  const all = [...state.kept.map(a => ({ ...a, url: assetUrl(state.editing, a), key: `old:${a.id}` })), ...state.files.map((f, i) => { const url = URL.createObjectURL(f); state.previewUrls.push(url); return { name: f.name, type: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : ''), size: f.size, url, key: `new:${i}` }; })];
  const preview = a => { $('#editor-preview').innerHTML = !a ? '' : a.type.startsWith('image/') ? `<img src="${a.url}" alt="${esc(a.name)}">` : a.type === 'application/pdf' ? pdfPreview(a.name, a.url) : ''; };
  preview(unavailable(state.editing || {}) ? null : all.find(a => a.type.startsWith('image/') || a.type === 'application/pdf'));
  $('#attachment-list').innerHTML = all.map(a => `<div class="attachment-row">${icon(a.type.startsWith('image/') ? 'image' : 'file')}<span>${esc(a.name)} · ${size(a.size)}</span><button data-preview="${a.key}" type="button">查看</button>${!state.editing?.linkedSource ? `<button data-remove="${a.key}" type="button" ${state.saving ? 'disabled' : ''}>移除</button>` : ''}</div>`).join('');
  $$('[data-preview]').forEach(b => b.onclick = () => preview(all.find(a => a.key === b.dataset.preview)));
  $$('[data-remove]').forEach(b => b.onclick = () => { if (state.saving) return; const [kind, id] = b.dataset.remove.split(':'); if (kind === 'old') state.kept = state.kept.filter(a => a.id !== id); else state.files.splice(Number(id), 1); renderAttachments(); changed(true); });
}
function safeLink(source) { try { const u = new URL(source); if (['http:', 'https:'].includes(u.protocol)) return `<a class="detail-source" href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(source)} ↗</a>`; } catch {} return `<span class="detail-source">${esc(source)}</span>`; }
function openDetail(id, preserve = false) {
  const n = state.notes.find(n => n.id === id); if (!n) return;
  state.detailId = id; if (!preserve) state.materialIndex = 0;
  const a = n.attachments[state.materialIndex];
  let material = unavailable(n) ? `<div class="material-empty">${icon('file')}<span>原文件夹暂不可用，标注仍然保留。</span></div>` : a?.type.startsWith('image/') ? `<img class="detail-main-image" src="${assetUrl(n, a)}" alt="${esc(a.name)}">` : a?.type === 'application/pdf' ? pdfPreview(a.name, assetUrl(n, a) + '?download') : n.text ? `<div class="detail-text-art">${esc(n.text)}</div>` : `<div class="material-empty">${icon('book')}<span>这一则，留下的是你的感受。</span></div>`;
  if (n.attachments.length > 1 && !unavailable(n)) material += `<div class="material-nav"><button data-material="-1" aria-label="上一份附件" ${state.materialIndex === 0 ? 'disabled' : ''}>‹</button><span class="material-counter">${state.materialIndex + 1} / ${n.attachments.length} · ${esc(a.name)}</span><button data-material="1" aria-label="下一份附件" ${state.materialIndex === n.attachments.length - 1 ? 'disabled' : ''}>›</button></div>`;
  $('#detail-content').innerHTML = `<div class="detail-layout"><section class="detail-material">${material}</section><section class="detail-writing"><div class="detail-actions">${n.trashed ? `<button class="button" data-restore-note="${n.id}">恢复笔记</button>` : `<button class="button" id="edit-detail">写标注</button><button class="icon-button" id="export-detail" aria-label="导出这则笔记">${icon('download')}</button><button class="icon-button" id="trash-detail" aria-label="移入回收站">${icon('trash')}</button>`}<button class="icon-button" data-close="detail" aria-label="关闭笔记">${icon('close')}</button></div><div class="card-facets">${organizationLabel(n)}</div><h2>${esc(n.title)}</h2><div class="detail-date">${date(n.createdAt)}${n.linkedSource ? ' · 来自原文件夹' : ''}</div><div>${n.tags.map(t => `<span class="detail-tag">#${esc(t)}</span>`).join('')}</div><section class="detail-section"><h3>我的标注 · 原话</h3><p class="detail-comment">${esc(n.comment || '还没有标注，感受可以慢慢写。')}</p></section>${n.text ? `<section class="detail-section"><h3>${n.linkedSource ? '原目录中的文字材料' : '原始文字'}</h3><pre>${esc(n.text)}</pre></section>` : ''}${n.linkedSource ? `<section class="detail-section"><h3>原目录 · ${n.linkedSource.status === 'available' ? '保持连接' : '暂不可用'}</h3><span class="detail-source">${esc(n.linkedSource.directory)}</span></section>` : n.source ? `<section class="detail-section"><h3>来源</h3>${safeLink(n.source)}</section>` : ''}${n.organization ? `<section class="detail-section agent-section"><h3>Agent 整理${n.organizationState === 'stale' ? ' · 原件或标注有更新，需重新阅读' : ''}</h3><p>${esc(n.organization.summary)}</p>${n.organization.observations ? `<p>${esc(n.organization.observations)}</p>` : ''}${n.organization.preferenceInterpretation ? `<h3>对偏好的理解 · AI 推测</h3><p>${esc(n.organization.preferenceInterpretation)}</p>` : ''}</section>` : `<section class="detail-section"><h3>留给 Agent</h3><p class="pending-copy">调用审美笔记 Skill 时，Agent 会阅读原件和标注，按需整理与理解。</p></section>`}${n.attachments.length ? `<section class="detail-section"><h3>原件 · ${n.attachments.length} 份</h3>${n.attachments.map((a, i) => `<div class="detail-attachment">${icon('file')}<span>${esc(a.name)}</span>${!unavailable(n) ? `<button data-material-index="${i}">查看</button><a href="${assetUrl(n, a)}?download" download>下载</a>` : ''}</div>`).join('')}</section>` : ''}</section></div>`;
  if (!$('#detail').open) $('#detail').showModal();
  $('#edit-detail')?.addEventListener('click', () => openEditor(n));
  $('#export-detail')?.addEventListener('click', () => { $('#detail').close(); openExport([n.id]); });
  $('#trash-detail')?.addEventListener('click', async () => { try { await patch(n.id, { trashed: true }); $('#detail').close(); state.selected.delete(n.id); toast('已移入回收站，原件仍保留。'); } catch (e) { toast(e.message, true); } });
}
async function patch(id, change) { await api(`/api/notes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) }); await refresh(true); }
async function downloadResponse(response, name) { const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
let exportIds = [];
function openExport(ids) { exportIds = ids; $('#export-task').value = ''; $('#export-count').textContent = `${ids.length} 则记录 · 包含原件`; $('#export-dialog').showModal(); }
async function loadFolders() {
  const { folders } = await (await api('/api/folders')).json();
  $('#folder-list').innerHTML = folders.filter(f => f.enabled).map(f => `<div class="folder-card"><strong>${esc(f.name)}</strong><code>${esc(f.path)}</code><span>${f.status === 'available' ? `${f.fileCount} 份材料 · ${f.groupCount} 个目录组` : f.status === 'partial' ? '部分内容暂不可读' : esc(f.error || '等待检查')}</span><button class="text-button" data-disconnect="${f.id}">断开连接</button>${f.warnings?.length ? `<p>${esc(f.warnings.join('\n'))}</p>` : ''}</div>`).join('') || '<p class="folder-empty">还没有接入文件夹。你原来的目录和文件名都可以继续保留。</p>';
}
async function connectFolder(folderPath) { if (!folderPath.trim()) return; await api('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folderPath.trim().replace(/^"|"$/g, '') }) }); await loadFolders(); await refresh(true); $('#folder-path').value = ''; toast('文件夹已接入，原目录保持原样。'); }

$$('.new-note').forEach(e => e.onclick = () => openEditor());
$$('[data-view]').forEach(e => e.onclick = () => { state.view = e.dataset.view; state.tag = ''; endSelection(); });
$('#search').oninput = e => { state.query = e.target.value; render(); }; $('#sort').onchange = e => { state.sort = e.target.value; render(); };
$('#tag-filters').onclick = e => { const b = e.target.closest('[data-tag]'); if (b) { state.tag = b.dataset.tag; render(); } };
$('#select-mode').onclick = () => { state.selecting = !state.selecting; if (!state.selecting) state.selected.clear(); render(); };
$('#cancel-selection').onclick = endSelection; $('#select-all').onclick = () => { visibleNotes().forEach(n => state.selected.add(n.id)); render(); };
$('#export-selected').onclick = () => openExport([...state.selected]);
$('#note-comment').oninput = () => changed(); $('#material-text').oninput = () => changed(); $('#save-status').onclick = () => flushSave().catch(() => {});
$('#editor-close').onclick = closeEditor; $('#editor').addEventListener('cancel', e => { e.preventDefault(); closeEditor(); });
$('#file-input').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
document.addEventListener('click', async e => {
  try {
    const close = e.target.closest('[data-close]'); if (close) $(`#${close.dataset.close}`).close();
    const open = e.target.closest('[data-open]'); if (open) { if (state.selecting) { const id = open.dataset.open; state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); render(); } else openDetail(open.dataset.open); }
    const select = e.target.closest('[data-select]'); if (select) { const id = select.dataset.select; state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); render(); }
    const favorite = e.target.closest('[data-favorite]'); if (favorite) { const n = state.notes.find(n => n.id === favorite.dataset.favorite); await patch(n.id, { favorite: !n.favorite }); }
    const restore = e.target.closest('[data-restore-note]'); if (restore) { await patch(restore.dataset.restoreNote, { trashed: false }); $('#detail').close(); toast('已恢复。'); }
    const material = e.target.closest('[data-material]'); if (material) { state.materialIndex += Number(material.dataset.material); openDetail(state.detailId, true); }
    const index = e.target.closest('[data-material-index]'); if (index) { state.materialIndex = Number(index.dataset.materialIndex); openDetail(state.detailId, true); }
    const disconnect = e.target.closest('[data-disconnect]'); if (disconnect) { await api('/api/folders/' + disconnect.dataset.disconnect, { method: 'PATCH' }); await loadFolders(); await refresh(true); toast('已停止读取这个文件夹，原件和标注保留。'); }
  } catch (error) { toast(error.message, true); }
});
$('#folders-open').onclick = async () => { $('#folders-dialog').showModal(); try { await loadFolders(); } catch (e) { toast(e.message, true); } };
$('#pick-folder').onclick = async e => { e.currentTarget.disabled = true; try { const { path } = await (await api('/api/folders/pick', { method: 'POST' })).json(); if (path) await connectFolder(path); } catch (e) { toast(e.message + '，也可以粘贴完整路径接入。', true); } finally { $('#pick-folder').disabled = false; } };
$('#folder-path-form').onsubmit = async e => { e.preventDefault(); const button = $('button', e.currentTarget); button.disabled = true; try { await connectFolder($('#folder-path').value); } catch (e) { toast(e.message, true); } finally { button.disabled = false; } };
$('#sync-folders').onclick = async e => { e.currentTarget.disabled = true; try { await api('/api/folders/sync', { method: 'POST' }); await loadFolders(); await refresh(true); toast('已检查新增与修改。'); } catch (e) { toast(e.message, true); } finally { $('#sync-folders').disabled = false; } };
async function loadSkillInfo() {
  try {
    const info = await (await api('/api/skill')).json();
    $('#skill-state').textContent = info.installedVersion === info.version && info.linked ? '本机 Codex 已安装，并已关联当前笔记库' : info.installedVersion === info.version ? '本机 Codex 已安装；复制使用指令即可关联当前笔记库' : info.installed ? '本机已有旧版 Skill，可下载更新' : '尚未在本机 Codex 安装，可先下载安装包';
    $('#skill-state').classList.toggle('skill-ready', info.installedVersion === info.version && info.linked);
    $('#skill-version').textContent = `审美笔记 Skill · v${info.version}`;
    $('#ai-prompt').textContent = `请使用 $aesthetic-notes。\n笔记库位置：${info.libraryRoot}\n如果尚未关联这个笔记库，请先用 Skill 自带的 scripts/notes.mjs configure --library 命令关联上述位置。然后检查新增与修改的记录，阅读原件和我的标注，按需整理。\n本次任务：整理审美笔记。`;
  } catch (error) { $('#skill-state').textContent = '暂时无法确认安装状态：' + error.message; }
}
$('#connect-ai').onclick = async () => { $('#ai-dialog').showModal(); await loadSkillInfo(); }; $('#backup-open').onclick = () => $('#backup-dialog').showModal();
$('#download-skill').onclick = async e => {
  const button = e.currentTarget; button.disabled = true;
  try { await downloadResponse(await api('/api/skill/download'), 'aesthetic-notes-skill.zip'); toast('Skill 安装包已生成，请保存后解压安装。'); }
  catch (error) { toast('下载未完成：' + error.message, true); }
  finally { button.disabled = false; }
};
$('#copy-prompt').onclick = async () => { try { await navigator.clipboard.writeText($('#ai-prompt').textContent); toast('已复制。'); } catch { toast('可以手动选中这段文字复制。'); } };
$('#download-backup').onclick = async e => { const button = e.currentTarget; button.disabled = true; try { await downloadResponse(await api('/api/backup'), `审美笔记-备份-${new Date().toLocaleDateString('sv-SE')}.json`); toast('已生成备份；不可用的外部原件会在备份中注明。'); } catch (e) { toast(e.message, true); } finally { button.disabled = false; } };
$('#restore-input').onchange = async e => { const input = e.target, file = input.files[0]; if (!file) return; try { input.disabled = true; const payload = JSON.parse(await file.text()); const result = await (await api('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json(); await refresh(true); toast(`已恢复 ${result.count} 则副本，已有记录保留。`); } catch (e) { toast(e.message, true); } finally { input.value = ''; input.disabled = false; } };
$('#export-form').onsubmit = async e => { e.preventDefault(); $('#export-submit').disabled = true; try { await downloadResponse(await api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: exportIds, task: $('#export-task').value }) }), '审美笔记-本次参考.zip'); $('#export-dialog').close(); } catch (e) { toast(e.message, true); } finally { $('#export-submit').disabled = false; } };
document.addEventListener('paste', e => {
  if ($$('dialog[open]').some(d => d.id !== 'editor')) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); const normalized = files.map(f => /^(image|clipboard)\./.test(f.name) ? new File([f], `截图-${Date.now()}.${f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`, { type: f.type }) : f); if ($('#editor').open) addFiles(normalized); else openEditor(null, normalized); return; }
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!typing && !$('#editor').open) { const text = e.clipboardData?.getData('text/plain'); if (text) { e.preventDefault(); openEditor(null, [], text); } }
});
let dragDepth = 0;
document.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; } });
document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
document.addEventListener('drop', e => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; if ($$('dialog[open]').some(d => !['editor', 'detail'].includes(d.id))) return; const files = [...e.dataTransfer.files]; $('#editor').open ? addFiles(files) : openEditor(null, files); });
document.addEventListener('keydown', e => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || $$('dialog[open]').length || e.ctrlKey || e.metaKey || e.altKey) return; if (e.key === '/') { e.preventDefault(); $('#search').focus(); } if (e.key.toLowerCase() === 'n') openEditor(); });
window.addEventListener('beforeunload', e => { if (state.dirty || state.saving) { e.preventDefault(); e.returnValue = ''; } });
await refresh(true);
setInterval(() => { if (!state.saving) refresh(); }, 5000);
try { const info = await (await api('/api/info')).json(); $('#data-path').textContent = info.dataPath; } catch {}
