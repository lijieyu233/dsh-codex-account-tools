window.__ModuleLoader__.load({
  id: 'dsh-codex-account-tools',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef, useCallback } = React;
    const PKG = 'dsh-codex-account-tools';
    const STYLE = `
.cat-root{font-size:14px;line-height:1.6;max-width:960px;width:100%;min-width:0;color:inherit}
.cat-root *{box-sizing:border-box}.cat-root h2{font-size:20px;margin:0 0 4px}.cat-root h3{font-size:15px;margin:0}
.cat-muted{opacity:.66;font-size:12px}.cat-cards{display:grid;gap:16px;margin-top:18px}.cat-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;padding:18px;min-width:0}
.cat-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.cat-between{justify-content:space-between}.cat-stack{display:flex;flex-direction:column;gap:10px}.cat-root button{font:inherit;cursor:pointer;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:7px;background:transparent;color:inherit;padding:6px 12px;white-space:nowrap}.cat-root button:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}.cat-root button:disabled{opacity:.4;cursor:not-allowed}.cat-root button.cat-primary{background:#2563eb;color:white;border-color:#2563eb}.cat-root button:focus-visible,.cat-root textarea:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}
.cat-area{display:block;width:100%;min-height:145px;resize:vertical;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:8px;background:color-mix(in srgb,currentColor 3%,transparent);color:inherit;font:12px/1.6 ui-monospace,Consolas,monospace;padding:12px}.cat-area.cat-hidden{-webkit-text-security:disc}.cat-root input[type=checkbox]{accent-color:#2563eb}.cat-root label{display:flex;gap:7px;align-items:center;cursor:pointer}
.cat-badge{display:inline-flex;border-radius:5px;background:color-mix(in srgb,#60a5fa 15%,transparent);color:#60a5fa;padding:1px 7px;font-size:11px;white-space:nowrap}.cat-account{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}.cat-account:last-child{border:0}.cat-account-main{flex:1;min-width:0}.cat-account-name{overflow-wrap:anywhere}.cat-expiry{font-size:11px;opacity:.6}.cat-notice{padding:10px 12px;border-radius:7px;font-size:12px;overflow-wrap:anywhere;background:color-mix(in srgb,#60a5fa 10%,transparent)}.cat-notice.error{background:color-mix(in srgb,#ef4444 12%,transparent);color:#f87171}.cat-notice.success{background:color-mix(in srgb,#22c55e 10%,transparent);color:#4ade80}.cat-warn{font-size:12px;color:#f59e0b}.cat-preview{border-top:1px solid color-mix(in srgb,currentColor 15%,transparent);padding-top:12px}.cat-table{width:100%;border-collapse:collapse;font-size:12px}.cat-table th,.cat-table td{padding:7px 6px;text-align:left;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);overflow-wrap:anywhere}.cat-summary{font-weight:600}.cat-actions{display:flex;gap:8px;flex-wrap:wrap}.cat-chooser{display:flex;flex-direction:column;gap:9px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);padding-top:12px}.cat-file{display:none}.cat-mini{font-size:12px!important}.cat-download-confirm{border:1px solid #d97706;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px}.cat-root details summary{cursor:pointer}.cat-root code{font-size:11px}.cat-scroll{overflow-x:auto}
@media(max-width:640px){.cat-card{padding:12px}.cat-root h2{font-size:18px}.cat-table th:nth-child(3),.cat-table td:nth-child(3){display:none}}
`;
    const actionText = { add: '新增', update: '更新令牌', skip: '保持不变' };
    function dateText(value) {
      return value > 0 ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知（将尝试刷新）';
    }
    function Tools({ call, embedded = false }) {
      const [data, setData] = useState(null), [readError, setReadError] = useState('');
      const [busy, setBusy] = useState(''), [notice, setNotice] = useState(null);
      const [text, setText] = useState(''), [visible, setVisible] = useState(false), [preview, setPreview] = useState(null);
      const [selected, setSelected] = useState([]), [secretConfirm, setSecretConfirm] = useState(false), [ack, setAck] = useState(false);
      const file = useRef(null), initialized = useRef(false), alive = useRef(true), lock = useRef(false);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      const load = useCallback(async () => {
        try {
          const next = await call('accounts/list');
          if (!alive.current) return;
          setData(next); setReadError('');
          const firstLoad = !initialized.current;
          initialized.current = true;
          setSelected((previous) => firstLoad ? next.accounts.map((a) => a.id) : previous.filter((id) => next.accounts.some((a) => a.id === id)));
        } catch (error) { if (alive.current) setReadError(error.message); }
      }, [call]);
      useEffect(() => { load(); }, [load]);
      const run = async (operation, fn) => {
        if (lock.current) return;
        lock.current = true; setBusy(operation); setNotice(null);
        try { await fn(); }
        catch (error) { if (alive.current) setNotice({ kind: 'error', message: error.message }); }
        finally { lock.current = false; if (alive.current) setBusy(''); }
      };
      const changeText = (value) => { setText(value); setPreview(null); setNotice(null); };
      const onPreview = () => run('preview', async () => { const p = await call('accounts/preview', { text }); if (alive.current) setPreview(p); });
      const onImport = () => run('import', async () => {
        const result = await call('accounts/import', { text, revision: preview.revision });
        if (!alive.current) return;
        setText(''); setPreview(null); setVisible(false);
        setNotice({ kind: 'success', message: `导入完成：新增 ${result.added} 个，更新 ${result.updated} 个，保持不变 ${result.skipped} 个。当前共 ${result.total} 个账号，当前使用的账号未改变。${(result.warnings || []).join(' ')}` });
        await load();
      });
      const onFile = (event) => {
        const chosen = event.target.files?.[0]; event.target.value = '';
        if (!chosen) return;
        run('file', async () => {
          if (chosen.size > 2 * 1024 * 1024) throw new Error('JSON 文件不能超过 2 MB。');
          changeText(await chosen.text());
          setNotice({ kind: 'info', message: '文件已读取，尚未导入。请先预览。' });
        });
      };
      const download = (includeSecrets) => run('export', async () => {
        const result = await call('accounts/export', { ids: selected, includeSecrets, confirmed: includeSecrets && ack });
        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `codex-accounts-${includeSecrets ? 'backup' : 'redacted'}-${new Date().toISOString().slice(0, 10)}.json`;
        a.hidden = true; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setSecretConfirm(false); setAck(false);
        setNotice({ kind: 'success', message: `已生成 ${result.accounts.length} 个账号的${includeSecrets ? '完整备份。该文件含登录令牌，请安全保管，不要发送到聊天或公开仓库。' : '脱敏清单（不含令牌，不能用来恢复账号）。'}` });
      });
      const accountRows = data?.accounts.map((a) => h('div', { className: 'cat-account', key: a.id },
        h('input', { type: 'checkbox', 'aria-label': `选择 ${a.label}`, checked: selected.includes(a.id), disabled: !!busy, onChange: (e) => setSelected((ids) => e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id)) }),
        h('div', { className: 'cat-account-main' }, h('div', { className: 'cat-account-name' }, a.label), h('div', { className: 'cat-expiry' }, `访问令牌到期：${dateText(a.expires)}`)),
        a.active ? h('span', { className: 'cat-badge' }, '当前使用') : null
      ));
      return h('section', { className: 'cat-root', 'data-testid': 'codex-account-tools', 'aria-busy': !!busy },
        !embedded && h('h2', null, 'Codex 账号工具'),
        h('div', { className: 'cat-muted' }, '配合 Codex 订阅插件使用 · 仅在本机 DSH 中处理账号，不上传到第三方服务'),
        h('div', { className: 'cat-cards' },
          h('div', { className: 'cat-card cat-stack' },
            h('div', { className: 'cat-row cat-between' }, h('h3', null, '已保存的账号'), h('button', { type: 'button', disabled: !!busy, onClick: () => run('refresh', load) }, busy === 'refresh' ? '刷新中…' : '刷新列表')),
            readError && h('div', { className: 'cat-notice error', role: 'alert' }, `读取失败：${readError} 原有账号未被删除。`),
            data === null && !readError && h('p', { className: 'cat-muted' }, '正在读取 DSH 账号库…'),
            data && h('div', null, data.accounts.length ? accountRows : h('p', { className: 'cat-muted' }, '账号库为空，可在下方导入。')),
            data && data.accounts.length > 0 && h('div', { className: 'cat-chooser' },
              h('div', { className: 'cat-row cat-between' }, h('label', null, h('input', { type: 'checkbox', checked: selected.length === data.accounts.length, disabled: !!busy, onChange: (e) => setSelected(e.target.checked ? data.accounts.map((a) => a.id) : []) }), `全选（已选 ${selected.length} / ${data.total}）`)),
              h('div', { className: 'cat-actions' },
                h('button', { type: 'button', disabled: !!busy || !selected.length, onClick: () => download(false) }, '导出脱敏清单'),
                h('button', { type: 'button', disabled: !!busy || !selected.length, onClick: () => { setSecretConfirm(true); setAck(false); } }, '导出完整备份…')),
              secretConfirm && h('div', { className: 'cat-download-confirm', role: 'group', 'aria-label': '确认导出完整备份' },
                h('strong', null, '完整备份包含登录凭据'),
                h('div', { className: 'cat-muted' }, '持有该 JSON 的人可能使用这些账号。文件为明文，仅保存到可信位置，不会自动复制到剪贴板。'),
                h('label', null, h('input', { type: 'checkbox', checked: ack, onChange: (e) => setAck(e.target.checked) }), '我理解风险，并确认下载所选账号的令牌'),
                h('div', { className: 'cat-actions' }, h('button', { type: 'button', className: 'cat-primary', disabled: !!busy || !ack, onClick: () => download(true) }, busy === 'export' ? '正在导出…' : '确认下载备份'), h('button', { type: 'button', disabled: !!busy, onClick: () => setSecretConfirm(false) }, '取消'))
              )
            ),
            h('div', { className: 'cat-muted' }, '这里只显示脱敏账号和令牌时间，不代表认证或订阅有效；切换、移除和在线验证请使用「Codex 订阅」。')
          ),
          h('div', { className: 'cat-card cat-stack' },
            h('div', { className: 'cat-row cat-between' }, h('h3', null, '导入账号 JSON'), h('button', { type: 'button', disabled: !!busy, onClick: () => file.current?.click() }, '选择 JSON 文件')),
            h('input', { ref: file, className: 'cat-file', type: 'file', accept: '.json,application/json', onChange: onFile, 'aria-label': '选择账号 JSON 文件' }),
            h('div', { className: 'cat-muted' }, '支持单个账号、数组、本工具的完整备份、Codex CLI 的 tokens 格式及 DSH credential 格式。上限 2 MB / 100 个账号。'),
            h('textarea', { className: `cat-area${visible ? '' : ' cat-hidden'}`, value: text, disabled: !!busy, spellCheck: false, autoComplete: 'off', 'aria-label': '账号 JSON', placeholder: '在这里粘贴账号 JSON（包含 access_token 和 refresh_token）', onChange: (e) => changeText(e.target.value) }),
            h('div', { className: 'cat-row cat-between' }, h('label', { className: 'cat-muted' }, h('input', { type: 'checkbox', checked: visible, onChange: (e) => setVisible(e.target.checked) }), '显示 JSON 内容（含敏感令牌）'), h('button', { type: 'button', className: 'cat-mini', disabled: !!busy || !text, onClick: () => { changeText(''); setVisible(false); } }, '清空输入')),
            h('div', { className: 'cat-actions' }, h('button', { type: 'button', className: 'cat-primary', disabled: !!busy || !text.trim(), onClick: onPreview }, busy === 'preview' ? '正在校验…' : '校验并预览')),
            preview && h('div', { className: 'cat-preview cat-stack', 'data-testid': 'import-preview' },
              h('div', { className: 'cat-summary' }, `预计新增 ${preview.added} 个、更新 ${preview.updated} 个、保持不变 ${preview.skipped} 个`),
              h('div', { className: 'cat-scroll' }, h('table', { className: 'cat-table' }, h('thead', null, h('tr', null, h('th', null, '账号'), h('th', null, '操作'), h('th', null, '访问令牌到期'))), h('tbody', null, preview.rows.map((r) => h('tr', { key: r.index }, h('td', null, r.label), h('td', null, actionText[r.action]), h('td', null, dateText(r.expires))))))),
              ...preview.rows.flatMap((r) => r.warnings.map((w, i) => h('div', { className: 'cat-warn', key: `${r.index}-${i}` }, `${r.label}：${w}`))),
              h('div', { className: 'cat-muted' }, '预览仅检查本地格式和重复项，不会向 OpenAI 发送请求。确认后合并写入；不删除其他账号、不改变当前选中账号。'),
              h('button', { type: 'button', className: 'cat-primary', disabled: !!busy || (!preview.added && !preview.updated), onClick: onImport }, busy === 'import' ? '正在写入…' : '确认导入')
            ),
            h('details', null, h('summary', { className: 'cat-muted' }, '支持的 JSON 字段与安全说明'), h('div', { className: 'cat-muted' }, '必需：access_token、refresh_token。可选：id_token、account_id、email、expires / expires_at。也可提供 credential: {type:"oauth", access, refresh, expires}。JWT 到期时间仅作参考；无法解码时不会捏造有效期。相同账号与用户才会更新，团队中的不同成员不会仅因 account_id 相同被合并。输入仅存在当前页面内存，离开页面后清除。'))
          ),
          notice && h('div', { className: `cat-notice ${notice.kind}`, role: notice.kind === 'error' ? 'alert' : 'status' }, notice.message)
        )
      );
    }
    function apply(ctx) {
      const transport = ctx.get('connection').rpc;
      const call = async (endpoint, payload = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          let response;
          try { response = await transport.call('/api', `codex-account-tools/${endpoint}`, payload, controller.signal); }
          catch { throw new Error('与 DSH 的请求未能完成。请刷新列表检查结果；若仍失败，请重新加载插件。'); }
          if (!response?.ok) throw new Error(response?.error?.message || '操作未能完成，请重试。');
          return response.value;
        } finally { clearTimeout(timer); }
      };
      const shared = { call };
      ctx.effect(() => {
        const tag = document.createElement('style'); tag.dataset.plugin = PKG; tag.textContent = STYLE;
        document.head.append(tag); return () => tag.remove();
      }, 'codex-account-tools: styles');
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'codex-account-tools', order: 16, label: () => 'Codex 账号工具', inject: () => shared }, Tools));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PKG, inject: () => ({ ...shared, embedded: true }) }, Tools));
      ctx.inject(['pluginNavigation'], (scope) => {
        const open = () => scope.get('pluginNavigation').openBundle(PKG);
        const Action = ({ subject }) => subject?.kind === 'bundle' && subject.pkg.name === 'dsh-codex-subscription' ? h('button', { type: 'button', onClick: open }, '账号导入 / 导出') : null;
        scope.slots.inject('plugins.detail.actions', () => scope.slots.register({ name: 'plugins.detail.actions', id: 'codex-account-tools/open', inject: () => ({}) }, Action));
      });
    }
    return { apply, inject: ['slots', 'connection'] };
  }
});
