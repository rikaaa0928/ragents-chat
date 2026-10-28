export async function mount(container, ctx) {
  let currentZone = 'workspace';
  let currentPath = '';
  let previewData = null;
  let uploading = false;

  const room = ctx.room;
  if (!room) {
    container.innerHTML = `<div class="p-6 text-center text-xs text-[var(--text-muted)]">请先选择一个聊天室</div>`;
    return;
  }

  // If the room is Floating (no workspace_path), default to tmp zone
  const hasWorkspace = Boolean(
    room.workspace_path ||
      (ctx.agents || []).some(
        (a) => a.scheduling?.mode === 'pinned' && a.scheduling?.workspace_path
      )
  );
  if (!hasWorkspace) {
    currentZone = 'tmp';
  }

  container.innerHTML = `
    <div class="flex flex-col h-full text-xs text-[var(--text-primary)] select-text">
      <!-- Header (52px) -->
      <div class="h-[52px] px-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0 bg-[var(--bg-main)]">
        <div class="flex items-center gap-1.5 min-w-0">
          <span>📁</span>
          <span class="font-semibold text-[13px] truncate">文件穿透 (${escapeHtml(room.name)})</span>
        </div>
        <button id="fs-close-col" class="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer" title="隐藏文件竖列">
          ✕
        </button>
      </div>

      <!-- Zone Tabs (Workspace vs Temp) -->
      <div class="p-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] space-y-2 shrink-0">
        <div class="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
          <button id="fs-tab-ws" type="button" ${!hasWorkspace ? 'disabled' : ''} class="py-1.5 px-2 rounded-md text-[11px] font-semibold cursor-pointer transition-colors ${!hasWorkspace ? 'opacity-40 cursor-not-allowed' : ''}">
            📂 工作区
          </button>
          <button id="fs-tab-tmp" type="button" class="py-1.5 px-2 rounded-md text-[11px] font-semibold cursor-pointer transition-colors">
            🗂️ 临时区 (可上传)
          </button>
        </div>

        <!-- Path Bar & Actions -->
        <div class="flex items-center justify-between gap-1.5">
          <div class="flex items-center gap-1 min-w-0 flex-1 px-2 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code text-[10.5px]">
            <button id="fs-up-btn" type="button" class="px-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer shrink-0" title="返回上级目录">⬆️</button>
            <span id="fs-path-label" class="truncate text-[var(--text-secondary)]">/</span>
          </div>
          <button id="fs-refresh-btn" type="button" class="px-2 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[11px] cursor-pointer shrink-0" title="刷新目录">
            🔄
          </button>
          <label id="fs-upload-label" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-[11px] cursor-pointer shrink-0 flex items-center gap-1">
            <span>📤 上传</span>
            <input id="fs-upload-input" type="file" multiple class="hidden" />
          </label>
        </div>
        <div id="fs-root-hint" class="text-[10px] font-mono-code text-[var(--text-muted)] truncate"></div>
      </div>

      <!-- Directory Entries & File Preview Scroll Container -->
      <div id="fs-content" class="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2.5"></div>
    </div>
  `;

  container.querySelector('#fs-close-col').addEventListener('click', () => ctx.close());
  const tabWs = container.querySelector('#fs-tab-ws');
  const tabTmp = container.querySelector('#fs-tab-tmp');
  const upBtn = container.querySelector('#fs-up-btn');
  const refreshBtn = container.querySelector('#fs-refresh-btn');
  const uploadLabel = container.querySelector('#fs-upload-label');
  const uploadInput = container.querySelector('#fs-upload-input');
  const pathLabel = container.querySelector('#fs-path-label');
  const rootHint = container.querySelector('#fs-root-hint');
  const contentEl = container.querySelector('#fs-content');

  function syncTabs() {
    const activeCls = 'bg-[var(--bg-main)] text-[var(--text-primary)] shadow-2xs';
    const inactiveCls = 'text-[var(--text-muted)] hover:text-[var(--text-primary)]';
    tabWs.className = `py-1.5 px-2 rounded-md text-[11px] font-semibold transition-colors ${
      !hasWorkspace ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
    } ${currentZone === 'workspace' ? activeCls : inactiveCls}`;
    tabTmp.className = `py-1.5 px-2 rounded-md text-[11px] font-semibold cursor-pointer transition-colors ${
      currentZone === 'tmp' ? activeCls : inactiveCls
    }`;
    uploadLabel.style.display = currentZone === 'tmp' ? 'inline-flex' : 'none';
    pathLabel.textContent = currentPath ? `/${currentPath}` : '/';
  }

  tabWs.addEventListener('click', () => {
    if (!hasWorkspace) return;
    currentZone = 'workspace';
    currentPath = '';
    previewData = null;
    syncTabs();
    loadDir();
  });

  tabTmp.addEventListener('click', () => {
    currentZone = 'tmp';
    currentPath = '';
    previewData = null;
    syncTabs();
    loadDir();
  });

  upBtn.addEventListener('click', () => {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    currentPath = parts.join('/');
    previewData = null;
    syncTabs();
    loadDir();
  });

  refreshBtn.addEventListener('click', () => loadDir());

  uploadInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    uploading = true;
    renderLoading('正在上传文件到临时目录...');
    try {
      for (const file of files) {
        const base64 = await readFileAsBase64(file);
        await ctx.extFetch(`/rooms/${encodeURIComponent(room.room_id)}/upload`, {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            sub_dir: currentPath || 'uploads',
            data_base64: base64,
            dedupe: false,
          }),
        });
      }
      uploadInput.value = '';
      await loadDir();
    } catch (err) {
      ctx.showError(err?.message || String(err));
      await loadDir();
    } finally {
      uploading = false;
    }
  });

  function renderLoading(msg) {
    contentEl.innerHTML = `<div class="py-10 text-center text-[var(--text-muted)]">${escapeHtml(msg)}</div>`;
  }

  async function loadDir() {
    syncTabs();
    renderLoading('正在读取节点目录...');
    try {
      const q = `?zone=${encodeURIComponent(currentZone)}&path=${encodeURIComponent(currentPath)}`;
      const res = await ctx.extFetch(`/rooms/${encodeURIComponent(room.room_id)}/list${q}`);
      if (!res.ok) {
        contentEl.innerHTML = `<div class="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-500 font-mono-code text-[11px]">${escapeHtml(res.error || '读取目录失败')}</div>`;
        return;
      }
      rootHint.textContent = `节点路径: ${res.root_dir || ''}`;
      rootHint.title = res.root_dir || '';
      renderEntries(res.entries || [], res.agent_path || '');
    } catch (err) {
      contentEl.innerHTML = `<div class="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-500 font-mono-code text-[11px]">${escapeHtml(err?.message || String(err))}</div>`;
    }
  }

  function renderEntries(entries, dirAgentPath) {
    const listHtml =
      entries.length === 0
        ? `<div class="py-8 text-center text-[var(--text-muted)] text-[11px]">
            ${currentZone === 'tmp' ? '临时目录为空，点击右上角「📤 上传」可将文件上传至此目录' : '当前目录为空'}
           </div>`
        : `<div class="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-main)] divide-y divide-[var(--border-subtle)] overflow-hidden">
            ${entries
              .map((ent) => {
                const icon = ent.is_dir ? '📁' : isImageName(ent.name) ? '🖼️' : '📄';
                const sizeText = ent.is_dir ? '目录' : formatBytes(ent.size || 0);
                return `
                  <div class="px-2.5 py-1.5 flex items-center justify-between gap-2 hover:bg-[var(--bg-hover)] group">
                    <button type="button" data-entry-path="${escapeAttr(ent.rel_path)}" data-entry-dir="${ent.is_dir ? '1' : '0'}" class="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer">
                      <span class="shrink-0">${icon}</span>
                      <span class="font-mono-code text-[11.5px] truncate ${ent.is_dir ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}">
                        ${escapeHtml(ent.name)}
                      </span>
                    </button>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <span class="text-[10px] font-mono-code text-[var(--text-muted)]">${sizeText}</span>
                      ${
                        !ent.is_dir
                          ? `<a href="/api/v1/ext/workspace_fs/rooms/${encodeURIComponent(room.room_id)}/raw?zone=${encodeURIComponent(currentZone)}&path=${encodeURIComponent(ent.rel_path)}&download=1" target="_blank" rel="noopener" class="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--bg-active)] text-[10px] text-[var(--text-secondary)]" title="下载文件">⬇️</a>`
                          : ''
                      }
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>`;

    let previewHtml = '';
    if (previewData) {
      const rawUrl = `/api/v1/ext/workspace_fs/rooms/${encodeURIComponent(room.room_id)}/raw?zone=${encodeURIComponent(currentZone)}&path=${encodeURIComponent(previewData.resolved_rel_path)}`;
      const isImg = (previewData.mime_type || '').startsWith('image/');
      previewHtml = `
        <div class="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden space-y-2 p-3">
          <div class="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2">
            <div class="min-w-0">
              <div class="font-mono-code font-semibold text-[11.5px] text-[var(--text-primary)] truncate" title="${escapeAttr(previewData.agent_path)}">
                ${escapeHtml(previewData.agent_path)}
              </div>
              <div class="text-[10px] text-[var(--text-muted)] font-mono-code">
                ${formatBytes(previewData.size || 0)} · ${escapeHtml(previewData.mime_type || '')}
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button id="fs-insert-path" type="button" class="px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 text-[10.5px] font-semibold cursor-pointer" title="将此文件路径插入聊天输入框供 Agent 读取">
                + 引用到对话
              </button>
              <a href="${rawUrl}&download=1" target="_blank" rel="noopener" class="px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[10.5px]">
                ⬇️ 下载
              </a>
            </div>
          </div>
          ${
            isImg
              ? `<div class="flex justify-center bg-[var(--bg-main)] p-2 rounded-lg border border-[var(--border-subtle)]">
                  <img src="${rawUrl}" alt="${escapeAttr(previewData.resolved_rel_path)}" class="max-h-[280px] rounded object-contain" />
                 </div>`
              : previewData.is_text
              ? `<pre class="text-[11px] font-mono-code leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-[340px] overflow-y-auto">${escapeHtml(previewData.text_preview || '')}${previewData.truncated ? '\n\n[文件较大，仅展示前 512KB 预览]' : ''}</pre>`
              : `<div class="py-4 text-center text-[11px] text-[var(--text-muted)]">二进制文件，请点击右上角「⬇️ 下载」查看</div>`
          }
        </div>
      `;
    }

    contentEl.innerHTML = listHtml + previewHtml;

    contentEl.querySelectorAll('[data-entry-path]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const p = btn.getAttribute('data-entry-path') || '';
        const isDir = btn.getAttribute('data-entry-dir') === '1';
        if (isDir) {
          currentPath = p;
          previewData = null;
          await loadDir();
        } else {
          const q = `?zone=${encodeURIComponent(currentZone)}&path=${encodeURIComponent(p)}`;
          const res = await ctx.extFetch(`/rooms/${encodeURIComponent(room.room_id)}/read${q}`);
          if (res.ok) {
            previewData = res;
            renderEntries(entries, dirAgentPath);
          } else {
            ctx.showError(res.error || '预览文件失败');
          }
        }
      });
    });

    const insertBtn = contentEl.querySelector('#fs-insert-path');
    if (insertBtn && previewData) {
      insertBtn.addEventListener('click', () => {
        const isImg = (previewData.mime_type || '').startsWith('image/');
        const tag = isImg
          ? `[Attached Image: ${previewData.agent_path}]`
          : `[Attached File: ${previewData.agent_path}]`;
        ctx.insertComposerText(tag);
      });
    }
  }

  await loadDir();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function isImageName(name) {
  return /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(name || '');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}
