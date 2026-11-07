import { createHash, randomUUID } from 'node:crypto';

export const VAULT_KEY = 'codex-subscription/accounts';
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ACCOUNTS = 100;
const AUTH = 'https://api.openai.com/auth';
const PROFILE = 'https://api.openai.com/profile';

export class AccountError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new AccountError(code, message); };
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const digest = (x) => createHash('sha256').update(JSON.stringify(x ?? null)).digest('hex');
const labelOf = (x) => String(x || '未命名账号').trim().replace(/\s+/gu, ' ').slice(0, 48) || '未命名账号';
const authOf = (token) => claims(token)[AUTH] || {};

// JWT claims are unverified metadata, never proof of account/subscription validity.
export function claims(token) {
  try {
    const data = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return object(data) ? data : {};
  } catch { return {}; }
}
function token(value, name, index) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_CREDENTIAL', `第 ${index + 1} 项缺少 ${name}。`);
  if (value.length > 131072 || /\s/u.test(value.trim())) fail('INVALID_CREDENTIAL', `第 ${index + 1} 项的 ${name} 格式不正确。`);
  return value.trim();
}
export function maskLabel(label) {
  const s = labelOf(label);
  const at = s.indexOf('@');
  return at > 0 ? `${s.slice(0, 1)}***${s.slice(at)}` : `${s.slice(0, 2)}***`;
}
export function validateRecord(record) {
  if (record === undefined) return;
  const p = record?.payload;
  if (record?.kind !== 'grant' || p?.version !== 1 || !Array.isArray(p.accounts) || !p.accounts.length) fail('VAULT_FORMAT', '现有账号库格式不受支持，已停止操作，未覆盖原数据。');
  const ids = new Set();
  for (const a of p.accounts) {
    const c = a?.credential;
    if (!object(a) || typeof a.id !== 'string' || !a.id || ids.has(a.id)
      || typeof a.label !== 'string' || !a.label.trim() || a.label.trim().replace(/\s+/gu, ' ').length > 48
      || !object(c) || c.type !== 'oauth' || typeof c.access !== 'string' || !c.access
      || typeof c.refresh !== 'string' || !c.refresh || !Number.isFinite(c.expires)) fail('VAULT_FORMAT', '现有账号库校验失败，未修改任何账号。');
    ids.add(a.id);
  }
  if (!ids.has(p.activeId) || (p.legacyAccountId !== undefined && !ids.has(p.legacyAccountId))) fail('VAULT_FORMAT', '现有账号库的选中账号无效，未修改数据。');
}

function normalizeOne(item, i, now) {
  if (!object(item)) fail('INVALID_ITEM', `第 ${i + 1} 项必须是账号对象。`);
  const raw = object(item.credential) ? item.credential : object(item.tokens) ? item.tokens : item;
  if (object(item.credential) && raw.type !== undefined && raw.type !== 'oauth') fail('INVALID_CREDENTIAL', `第 ${i + 1} 项不是 OAuth 凭据。`);
  const access = token(raw.access ?? raw.access_token, 'access_token', i);
  const refresh = token(raw.refresh ?? raw.refresh_token, 'refresh_token', i);
  const idToken = raw.idToken ?? raw.id_token ?? item.id_token;
  if (idToken !== undefined && typeof idToken !== 'string') fail('INVALID_CREDENTIAL', `第 ${i + 1} 项的 id_token 必须是文本。`);
  const a = claims(access), id = claims(idToken), aa = a[AUTH] || {}, ia = id[AUTH] || {};
  const givenId = raw.accountId ?? raw.account_id ?? item.account_id;
  const claimedId = aa.chatgpt_account_id ?? ia.chatgpt_account_id;
  if (claimedId !== undefined && (typeof claimedId !== 'string' || !claimedId || claimedId.length > 256)) fail('ACCOUNT_ID', `第 ${i + 1} 项的令牌账号标识格式不正确。`);
  if (givenId !== undefined && (typeof givenId !== 'string' || !givenId.trim() || givenId.length > 256)) fail('ACCOUNT_ID', `第 ${i + 1} 项的 account_id 格式不正确。`);
  if (givenId && claimedId && givenId.trim() !== claimedId) fail('ACCOUNT_MISMATCH', `第 ${i + 1} 项的 account_id 与令牌中的账号不一致。`);
  const accountId = givenId?.trim() || claimedId;
  const email = raw.email ?? item.email ?? a[PROFILE]?.email ?? a.email ?? id.email;
  const label = labelOf(item.label || email || `导入账号 ${i + 1}`);
  const warnings = [];
  let expires = a.exp !== undefined && Number.isFinite(a.exp) ? a.exp * 1000 : undefined;
  if (expires === undefined) {
    const e = raw.expires ?? item.expires ?? raw.expires_at ?? item.expires_at ?? item.expired;
    if (typeof e === 'number' && Number.isFinite(e)) expires = e > 1e12 ? e : e * 1000;
    else if (typeof e === 'string') expires = Date.parse(e);
  }
  if (!Number.isFinite(expires) || expires < 0 || expires > 8640000000000000) {
    expires = 0;
    warnings.push('无法确定访问令牌到期时间，将交由订阅插件刷新。');
  } else if (expires <= now) warnings.push('访问令牌已到期；能否刷新取决于 refresh_token 是否有效。');
  if (!accountId) warnings.push('未提供 account_id；只能按令牌识别重复账号。');
  const credential = { type: 'oauth', access, refresh, expires };
  if (accountId) credential.accountId = accountId;
  if (idToken) credential.idToken = token(idToken, 'id_token', i);
  if (typeof email === 'string' && email.length < 320) credential.email = email.trim();
  return { label, credential, warnings };
}

export function normalizeInput(text, now = Date.now()) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('INPUT_SIZE', 'JSON 不能超过 2 MB。');
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/u, '').trim()); }
  catch { fail('INVALID_JSON', 'JSON 格式有误，请检查括号、引号和逗号。'); }
  if (parsed?.redacted === true) fail('REDACTED', '这是脱敏清单，不包含令牌，不能用来恢复账号。');
  if (parsed?.format === 'dsh-codex-accounts' && parsed.version !== 1) fail('INPUT_VERSION', '不支持该备份版本。');
  const list = Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.accounts) ? parsed.accounts : [parsed];
  if (!list.length || list.length > MAX_ACCOUNTS) fail('ACCOUNT_COUNT', '每次应导入 1～100 个账号。');
  const items = list.map((x, i) => normalizeOne(x, i, now));
  for (let i = 0; i < items.length; i++) {
    if (items.slice(0, i).some((x) => sameAccount(x.credential, items[i].credential))) fail('BATCH_DUPLICATE', `第 ${i + 1} 项与本批次前面的账号重复，请保留一份再预览。`);
  }
  return items;
}
export function sameAccount(a, b) {
  if (a.access === b.access) return true;
  const aid = a.accountId || authOf(a.access).chatgpt_account_id;
  const bid = b.accountId || authOf(b.access).chatgpt_account_id;
  if (!aid || aid !== bid) return false;
  const ac = claims(a.access), bc = claims(b.access);
  const au = ac[AUTH]?.chatgpt_user_id, bu = bc[AUTH]?.chatgpt_user_id;
  // An organization/account ID alone is NOT a user identity. Match the official
  // subscription plugin's renewal check; never merge different team members.
  if (typeof au === 'string' && au && typeof bu === 'string' && bu) return au === bu;
  return typeof ac.sub === 'string' && !!ac.sub && ac.sub === bc.sub;
}
function buildPlan(record, items) {
  validateRecord(record);
  const accounts = record?.payload.accounts || [];
  const rows = items.map((item, i) => {
    const matches = accounts.filter((a) => sameAccount(a.credential, item.credential));
    if (matches.length > 1) fail('AMBIGUOUS_ACCOUNT', `第 ${i + 1} 项匹配到多个现有账号，已停止导入。`);
    const match = matches[0];
    // Preserve original labels/metadata; the import owns only explicit credential fields.
    const candidate = match ? { ...match, credential: { ...match.credential, ...item.credential } } : item;
    const action = !match ? 'add' : digest(candidate) === digest(match) ? 'skip' : 'update';
    return { index: i, id: match?.id, label: maskLabel(match?.label || item.label), action, expires: item.credential.expires, warnings: item.warnings };
  });
  return { revision: digest(record), rows, added: rows.filter((r) => r.action === 'add').length, updated: rows.filter((r) => r.action === 'update').length, skipped: rows.filter((r) => r.action === 'skip').length, total: accounts.length + rows.filter((r) => r.action === 'add').length };
}
// modifyRecord reconciles the on-disk state under the host lock. undefined is a read-only
// transaction, unlike readRecord which only returns this process's cached map.
export async function readVault(credentials) {
  const record = await credentials.modifyRecord(VAULT_KEY, () => undefined);
  validateRecord(record);
  return record;
}
export async function listAccounts(credentials) {
  const record = await readVault(credentials);
  return { version: 1, revision: digest(record), accounts: (record?.payload.accounts || []).map((a) => ({ id: a.id, label: maskLabel(a.label), active: a.id === record.payload.activeId, expires: a.credential.expires })), total: record?.payload.accounts.length || 0 };
}
export async function previewImport(credentials, text) {
  const items = normalizeInput(text);
  return buildPlan(await readVault(credentials), items);
}
export async function importAccounts(credentials, { text, revision }) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) fail('PREVIEW_REQUIRED', '请先预览本次导入，再确认写入。');
  const items = normalizeInput(text);
  let plan, legacyCredential;
  await credentials.modifyRecord(VAULT_KEY, (current) => {
    plan = buildPlan(current, items);
    if (revision !== plan.revision) fail('STALE_PREVIEW', '账号库已变化（可能发生令牌刷新），请重新预览后导入。');
    if (!plan.added && !plan.updated) return undefined;
    const p = current?.payload || { version: 1, accounts: [] };
    const accounts = [...p.accounts];
    for (const row of plan.rows) {
      const item = items[row.index];
      if (row.action === 'add') accounts.push({ id: randomUUID(), label: item.label, credential: item.credential });
      else if (row.action === 'update') {
        const i = accounts.findIndex((a) => a.id === row.id);
        accounts[i] = { ...accounts[i], credential: { ...accounts[i].credential, ...item.credential } };
      }
    }
    const next = { ...(current || {}), kind: 'grant', payload: { ...p, activeId: p.activeId || accounts[0].id, accounts } };
    validateRecord(next);
    if (p.legacyAccountId && plan.rows.some((row) => row.id === p.legacyAccountId && row.action === 'update')) legacyCredential = accounts.find((a) => a.id === p.legacyAccountId).credential;
    return next;
  });
  const warnings = [];
  // Match the subscription vault's post-commit rollback-reference synchronization.
  if (legacyCredential) {
    try { await credentials.set('OPENAI_CODEX_SUBSCRIPTION_OAUTH', JSON.stringify(legacyCredential)); }
    catch { warnings.push('账号已导入，但旧版兼容凭据同步失败；请勿降级订阅插件。'); }
  }
  return { added: plan.added, updated: plan.updated, skipped: plan.skipped, total: plan.total, activePreserved: true, warnings };
}
export async function exportAccounts(credentials, { ids, includeSecrets = false, confirmed = false } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) fail('SELECTION', '请至少选择一个账号。');
  if (includeSecrets && confirmed !== true) fail('CONFIRM_EXPORT', '导出完整令牌前需要确认敏感信息风险。');
  const record = await readVault(credentials);
  const selected = (record?.payload.accounts || []).filter((a) => ids.includes(a.id));
  if (selected.length !== ids.length) fail('SELECTION_CHANGED', '所选账号已变化，请刷新后重新选择。');
  return { format: 'dsh-codex-accounts', version: 1, redacted: !includeSecrets, exported_at: new Date().toISOString(), accounts: selected.map((a) => {
    const c = a.credential;
    const out = { type: 'codex', label: includeSecrets ? a.label : maskLabel(a.label), expires: c.expires };
    if (includeSecrets) {
      out.access_token = c.access;
      out.refresh_token = c.refresh;
      if (c.accountId) out.account_id = c.accountId;
      if (c.email) out.email = c.email;
      if (c.idToken) out.id_token = c.idToken;
    }
    return out;
  }) };
}
