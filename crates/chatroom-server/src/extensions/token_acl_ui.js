export async function mount(container, ctx) {
  if (ctx.slot === 'auth.login') {
    renderLoginModal(container, ctx);
    return;
  }
  await renderAdminModal(container, ctx);
}

function renderLoginModal(container, ctx) {
  container.innerHTML = `
    <div class="p-5 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <span>🔑</span>
          <span>输入访问 Token (token_acl)</span>
        </h3>
      </div>
      <p class="text-xs text-[var(--text-secondary)]">
        当前服务已启用可插拔 Token 权限认证。请输入管理员分配给您的访问 Token（不同 Token 对应独立用户名与节点/目录权限）。
      </p>
      <div class="space-y-2">
        <input
          id="ext-auth-token-input"
          type="password"
          placeholder="输入访问 Token (如 admin 或 rct_...)"
          class="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs font-mono-code text-[var(--text-primary)] outline-none"
        />
        <div id="ext-auth-err" class="text-[11px] text-rose-500 hidden"></div>
      </div>
      <div class="flex justify-end gap-2">
        <button
          id="ext-auth-submit"
          type="button"
          class="px-4 py-1.5 rounded-xl bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] text-xs font-semibold cursor-pointer hover:opacity-90"
        >
          验证并登录
        </button>
      </div>
    </div>
  `;

  const input = container.querySelector('#ext-auth-token-input');
  const errEl = container.querySelector('#ext-auth-err');
  const btn = container.querySelector('#ext-auth-submit');

  const submit = async () => {
    const val = (input.value || '').trim();
    if (!val) return;
    btn.disabled = true;
    errEl.classList.add('hidden');
    try {
      await ctx.onAuthSuccess(val);
    } catch (e) {
      errEl.textContent = e?.message || 'Token 验证失败';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  setTimeout(() => input.focus(), 30);
}

async function renderAdminModal(container, ctx) {
  container.innerHTML = `
    <div class="p-5 space-y-4 max-h-[85vh] overflow-y-auto text-xs text-[var(--text-primary)]">
      <div class="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
        <div>
          <h3 class="text-base font-semibold flex items-center gap-2">
            <span>🔑</span>
            <span>用户 Token 与节点权限管理 (token_acl 扩展)</span>
          </h3>
          <p class="text-[11px] text-[var(--text-muted)] mt-0.5">
            管理多用户访问 Token，并按用户限制允许访问的 Node、工作区目录前缀及沙箱最高审批粒度
          </p>
        </div>
        <button id="acl-close-btn" class="px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer">
          关闭
        </button>
      </div>
      <div id="acl-body" class="space-y-4">
        <div class="py-8 text-center text-[var(--text-muted)]">正在加载用户与节点列表...</div>
      </div>
    </div>
  `;

  container.querySelector('#acl-close-btn').addEventListener('click', () => ctx.close());
  const bodyEl = container.querySelector('#acl-body');

  let editingUserId = null;

  async function loadAndRender() {
    try {
      const data = await ctx.extFetch('/users');
      const users = data.users || [];
      const nodes = data.cluster_nodes || ctx.clusterNodes || [];

      const editingUser = editingUserId
        ? users.find((u) => u.user_id === editingUserId) || null
        : null;

      const initUsername = editingUser ? editingUser.username : '';
      const initDisplayName = editingUser ? editingUser.display_name : '';
      const initToken = editingUser ? editingUser.token : '';
      const initIsAdmin = editingUser ? Boolean(editingUser.is_admin) : false;
      const initScope = editingUser ? editingUser.max_approval_scope || 'session' : 'session';
      const initRestrictNodes = editingUser ? Array.isArray(editingUser.allowed_nodes) : false;
      const initAllowedNodes = new Set(
        editingUser && Array.isArray(editingUser.allowed_nodes)
          ? editingUser.allowed_nodes
          : ['__floating__']
      );
      const initWsLines = editingUser && editingUser.node_workspace_prefixes
        ? Object.entries(editingUser.node_workspace_prefixes)
            .map(([nid, list]) => `${nid}=${(list || []).join(',')}`)
            .join('\n')
        : '';

      bodyEl.innerHTML = `
        <!-- Existing Users Table -->
        <div class="space-y-2">
          <div class="font-semibold text-[12px] text-[var(--text-secondary)] flex items-center justify-between">
            <span>已注册用户 (${users.length})</span>
            ${editingUser ? `<button id="acl-cancel-edit" class="text-[11px] text-blue-500 hover:underline cursor-pointer">+ 切换为新建用户</button>` : ''}
          </div>
          <div class="space-y-2 max-h-[240px] overflow-y-auto pr-1">
            ${users
              .map((u) => {
                const nodesLabel = u.is_admin || !Array.isArray(u.allowed_nodes)
                  ? '全部节点'
                  : u.allowed_nodes.length === 0
                  ? '禁止所有节点'
                  : u.allowed_nodes.join(', ');
                const wsEntries = Object.entries(u.node_workspace_prefixes || {});
                const wsLabel = u.is_admin || wsEntries.length === 0
                  ? '节点默认允许目录'
                  : wsEntries.map(([k, v]) => `${k}: ${(v || []).join(', ')}`).join(' | ');
                return `
                  <div class="p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-1.5">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="font-semibold text-[13px]">@${escapeHtml(u.display_name)}</span>
                        <span class="font-mono-code text-[11px] text-[var(--text-muted)]">(${escapeHtml(u.username)})</span>
                        ${
                          u.is_admin
                            ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold">👑 Admin</span>'
                            : `<span class="px-1.5 py-0.5 rounded bg-blue-500/12 text-blue-600 dark:text-blue-400 text-[10px]">最高审批: ${escapeHtml(u.max_approval_scope)}</span>`
                        }
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        <button data-copy-token="${escapeAttr(u.token)}" class="px-2 py-1 rounded-md bg-[var(--bg-main)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[10.5px] font-mono-code cursor-pointer">
                          复制 Token
                        </button>
                        <button data-edit-user="${escapeAttr(u.user_id)}" class="px-2 py-1 rounded-md bg-[var(--bg-main)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[10.5px] cursor-pointer">
                          编辑
                        </button>
                        ${
                          u.user_id !== 'admin'
                            ? `<button data-del-user="${escapeAttr(u.user_id)}" class="px-2 py-1 rounded-md bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 text-[10.5px] cursor-pointer">删除</button>`
                            : ''
                        }
                      </div>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-1 text-[10.5px] font-mono-code text-[var(--text-secondary)]">
                      <div class="truncate">Token: <code class="text-[var(--text-primary)]">${escapeHtml(maskToken(u.token))}</code></div>
                      <div class="truncate" title="${escapeAttr(nodesLabel)}">允许节点: ${escapeHtml(nodesLabel)}</div>
                      <div class="truncate" title="${escapeAttr(wsLabel)}">目录限制: ${escapeHtml(wsLabel)}</div>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>

        <!-- Create / Edit User Form -->
        <div class="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] space-y-3">
          <div class="font-semibold text-[12.5px]">
            ${editingUser ? `✏️ 编辑用户 @${escapeHtml(editingUser.username)}` : '➕ 创建新用户 / 签发 Token'}
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label class="block text-[11px] text-[var(--text-muted)] mb-1">用户名 (唯一标识)</label>
              <input id="acl-username" type="text" value="${escapeAttr(initUsername)}" ${editingUser && editingUser.user_id === 'admin' ? 'disabled' : ''} placeholder="例如: alice" class="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code" />
            </div>
            <div>
              <label class="block text-[11px] text-[var(--text-muted)] mb-1">聊天室显示昵称 (发言 @ 名称)</label>
              <input id="acl-display" type="text" value="${escapeAttr(initDisplayName)}" placeholder="例如: Alice" class="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]" />
            </div>
          </div>

          <div>
            <label class="block text-[11px] text-[var(--text-muted)] mb-1">访问 Token</label>
            <div class="flex gap-2">
              <input id="acl-token" type="text" value="${escapeAttr(initToken)}" placeholder="留空自动生成随机 rct_... 密钥，或手动指定" class="flex-1 px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code" />
              <button id="acl-gen-token" type="button" class="px-2.5 py-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] text-[11px] cursor-pointer shrink-0">
                🎲 随机生成
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label class="block text-[11px] text-[var(--text-muted)] mb-1">角色权限</label>
              <select id="acl-is-admin" ${editingUser && editingUser.user_id === 'admin' ? 'disabled' : ''} class="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]">
                <option value="0" ${!initIsAdmin ? 'selected' : ''}>普通用户 (受下述 Node 与目录策略限制)</option>
                <option value="1" ${initIsAdmin ? 'selected' : ''}>管理员 Admin (拥有全部节点与管理权限)</option>
              </select>
            </div>
            <div>
              <label class="block text-[11px] text-[var(--text-muted)] mb-1">沙箱权限最高审批范围</label>
              <select id="acl-max-scope" class="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]">
                <option value="once" ${initScope === 'once' ? 'selected' : ''}>once (仅允许单次放行)</option>
                <option value="session" ${initScope === 'session' ? 'selected' : ''}>session (最高允许当前会话)</option>
                <option value="workspace" ${initScope === 'workspace' ? 'selected' : ''}>workspace (最高允许当前工作区)</option>
                <option value="node" ${initScope === 'node' ? 'selected' : ''}>node (允许节点全局永久放行)</option>
              </select>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="flex items-center gap-2 cursor-pointer">
              <input id="acl-restrict-nodes" type="checkbox" ${initRestrictNodes ? 'checked' : ''} class="accent-emerald-600" />
              <span class="text-[11px] font-medium">限制该用户可访问的节点白名单 (不勾选则允许访问所有节点)</span>
            </label>
            <div id="acl-nodes-box" class="flex flex-wrap gap-2 p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] ${initRestrictNodes ? '' : 'opacity-50'}">
              <label class="inline-flex items-center gap-1.5 text-[11px] font-mono-code cursor-pointer">
                <input type="checkbox" data-node-chk="__floating__" ${initAllowedNodes.has('__floating__') ? 'checked' : ''} />
                <span>__floating__ (浮动房间)</span>
              </label>
              ${nodes
                .map(
                  (n) => `
                <label class="inline-flex items-center gap-1.5 text-[11px] font-mono-code cursor-pointer">
                  <input type="checkbox" data-node-chk="${escapeAttr(n.metadata.id)}" ${initAllowedNodes.has(n.metadata.id) ? 'checked' : ''} />
                  <span>${escapeHtml(n.metadata.id)} (${escapeHtml(n.status?.phase || 'ready')})</span>
                </label>
              `
                )
                .join('')}
            </div>
          </div>

          <div>
            <label class="block text-[11px] text-[var(--text-muted)] mb-1">
              节点允许的工作区目录前缀限制 (每行一条，格式: <code>node_id=/path/prefix1,/path/prefix2</code>，留空表示不额外限制)
            </label>
            <textarea id="acl-ws-prefixes" rows="2" placeholder="例如:\nmacos-local-01=/Volumes/storage/src/ai/agents\nnode-docker-01=/var/lib/ragents/workspaces" class="w-full p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code text-[11px]">${escapeHtml(initWsLines)}</textarea>
          </div>

          <div class="flex justify-end gap-2">
            <button id="acl-save-user" type="button" class="px-4 py-1.5 rounded-xl bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] font-semibold cursor-pointer hover:opacity-90">
              ${editingUser ? '保存修改' : '创建用户并签发 Token'}
            </button>
          </div>
        </div>
      `;

      // Bind events
      bodyEl.querySelectorAll('[data-copy-token]').forEach((el) => {
        el.addEventListener('click', () => {
          const tok = el.getAttribute('data-copy-token') || '';
          navigator.clipboard.writeText(tok);
          el.textContent = '已复制 ✓';
          setTimeout(() => (el.textContent = '复制 Token'), 1200);
        });
      });

      bodyEl.querySelectorAll('[data-edit-user]').forEach((el) => {
        el.addEventListener('click', () => {
          editingUserId = el.getAttribute('data-edit-user');
          loadAndRender();
        });
      });

      bodyEl.querySelectorAll('[data-del-user]').forEach((el) => {
        el.addEventListener('click', async () => {
          const uid = el.getAttribute('data-del-user');
          if (!uid) return;
          await ctx.extFetch(`/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
          if (editingUserId === uid) editingUserId = null;
          await loadAndRender();
        });
      });

      const cancelEditBtn = bodyEl.querySelector('#acl-cancel-edit');
      if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', () => {
          editingUserId = null;
          loadAndRender();
        });
      }

      const restrictChk = bodyEl.querySelector('#acl-restrict-nodes');
      const nodesBox = bodyEl.querySelector('#acl-nodes-box');
      restrictChk.addEventListener('change', () => {
        nodesBox.classList.toggle('opacity-50', !restrictChk.checked);
      });

      bodyEl.querySelector('#acl-gen-token').addEventListener('click', () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        bodyEl.querySelector('#acl-token').value = `rct_${hex}`;
      });

      bodyEl.querySelector('#acl-save-user').addEventListener('click', async () => {
        const username = bodyEl.querySelector('#acl-username').value.trim();
        const display_name = bodyEl.querySelector('#acl-display').value.trim() || username;
        const token = bodyEl.querySelector('#acl-token').value.trim() || null;
        const is_admin = bodyEl.querySelector('#acl-is-admin').value === '1';
        const max_approval_scope = bodyEl.querySelector('#acl-max-scope').value;

        let allowed_nodes = null;
        if (restrictChk.checked) {
          allowed_nodes = [];
          bodyEl.querySelectorAll('[data-node-chk]').forEach((chk) => {
            if (chk.checked) allowed_nodes.push(chk.getAttribute('data-node-chk'));
          });
        }

        const node_workspace_prefixes = {};
        const rawLines = bodyEl.querySelector('#acl-ws-prefixes').value.split('\n');
        for (const line of rawLines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.includes('=')) continue;
          const idx = trimmed.indexOf('=');
          const nid = trimmed.slice(0, idx).trim();
          const paths = trimmed
            .slice(idx + 1)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (nid && paths.length > 0) {
            node_workspace_prefixes[nid] = paths;
          }
        }

        const payload = {
          username,
          display_name,
          token,
          is_admin,
          allowed_nodes,
          node_workspace_prefixes,
          max_approval_scope,
        };

        if (editingUser) {
          await ctx.extFetch(`/users/${encodeURIComponent(editingUser.user_id)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
        } else {
          await ctx.extFetch('/users', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }
        editingUserId = null;
        await loadAndRender();
      });
    } catch (e) {
      bodyEl.innerHTML = `<div class="p-4 rounded-xl bg-rose-500/10 text-rose-500">${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  await loadAndRender();
}

function maskToken(tok) {
  if (!tok) return '';
  if (tok.length <= 8) return tok;
  return `${tok.slice(0, 6)}...${tok.slice(-4)}`;
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
