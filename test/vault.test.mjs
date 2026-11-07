import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import {
  VAULT_KEY, MAX_BYTES, MAX_ACCOUNTS, AccountError, claims, maskLabel,
  normalizeInput, sameAccount, validateRecord, readVault, listAccounts,
  previewImport, importAccounts, exportAccounts,
} from '../lib/vault.js';
import { ENDPOINTS, createHandler, registerTransport } from '../lib/index.js';

// Coverage labels:
// [FILE UNIT] Every credential operation below uses an isolated, real temporary JSON
// document. Its queue/reconcile/undefined-no-write semantics model the verified host
// seam, but do NOT claim to test DSH's YAML provider, cross-process file lock or ACLs.
// [REQUEST UNIT] Real WHATWG Request/Response objects exercise registered callbacks
// and the actual client-injected call function. No network socket is opened, so this
// does NOT independently test the host's authenticated same-origin admission fence.
// All tokens and identities are generated synthetic fixtures; no live DSH home is read.
const AUTH = 'https://api.openai.com/auth';
const PROFILE = 'https://api.openai.com/profile';
const NOW = Date.parse('2030-01-01T00:00:00Z');
const EXP_SECONDS = 4102444800;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function jwt({ team = 'synthetic-team', user = 'synthetic-alice', subject = 'synthetic-sub', salt = 'initial', exp = EXP_SECONDS, email = 'alice@example.invalid' } = {}) {
  const auth = { chatgpt_account_id: team };
  if (user !== null) auth.chatgpt_user_id = user;
  const payload = { sub: subject, exp, [AUTH]: auth, [PROFILE]: { email } };
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.unit-test-${salt}`;
}
function credential(options = {}) {
  const team = options.team ?? 'synthetic-team';
  return {
    type: 'oauth', access: jwt(options), refresh: `synthetic-refresh-${options.salt ?? 'initial'}`,
    expires: EXP_SECONDS * 1000, accountId: team, email: options.email ?? 'alice@example.invalid',
  };
}
function account(id = 'saved-alice', options = {}) {
  return { id, label: options.label ?? 'Saved Alice', credential: credential(options), note: { owner: 'test fixture' } };
}
function vault(accounts = [account()], overrides = {}) {
  return { kind: 'grant', payload: { version: 1, activeId: accounts[0].id, accounts, ...overrides } };
}
function incoming(c = credential(), label = 'Imported label') {
  return JSON.stringify({ label, credential: c });
}
function hasCode(code) {
  return (error) => error instanceof AccountError && error.code === code;
}

async function fixture(t, initialRecord, refs = {}) {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'dsh-codex-account-tools-test-'));
  // Cleanup is confined to the precise directory returned by mkdtemp, never a DSH home.
  assert.equal(dirname(directory), root);
  assert.ok(basename(directory).startsWith('dsh-codex-account-tools-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const filename = join(directory, 'synthetic-credentials.json');
  const document = { refs: clone(refs), records: {} };
  if (initialRecord !== undefined) document.records[VAULT_KEY] = clone(initialRecord);
  await writeFile(filename, JSON.stringify(document), 'utf8');
  let cache = clone(document), tail = Promise.resolve();
  const writes = { records: 0, refs: 0 };
  const readDocument = async () => JSON.parse(await readFile(filename, 'utf8'));
  const persist = async (next) => {
    const temporary = join(directory, `replacement-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(next), 'utf8');
    await rename(temporary, filename);
    cache = clone(next);
  };
  const enqueue = (fn) => {
    const operation = tail.then(fn);
    tail = operation.catch(() => undefined);
    return operation;
  };
  const credentials = {
    readRecord(key) { return Promise.resolve(cache.records[key]); },
    modifyRecord(key, mutate) {
      return enqueue(async () => {
        const fresh = await readDocument();
        cache = clone(fresh);
        const current = fresh.records[key];
        const next = await mutate(current);
        if (next === undefined) return current;
        fresh.records[key] = next;
        await persist(fresh);
        writes.records += 1;
        return next;
      });
    },
    set(ref, value) {
      return enqueue(async () => {
        const fresh = await readDocument();
        fresh.refs[ref] = value;
        await persist(fresh);
        writes.refs += 1;
      });
    },
  };
  return {
    credentials, writes, readDocument,
    bytes: () => readFile(filename, 'utf8'),
    async externalReplace(record) {
      await tail;
      const fresh = await readDocument();
      fresh.records[VAULT_KEY] = clone(record);
      // Deliberately do not update this process's cache: model another writer.
      await writeFile(filename, JSON.stringify(fresh), 'utf8');
    },
  };
}

// Match the host browser's envelope/result validation rather than assuming the
// route can return bare account data. Endpoint assertions below also require value.
function browserResult(envelope, rpcId) {
  assert.equal(envelope?.type, 'server-response');
  assert.equal(typeof envelope.rpcId, 'string');
  assert.equal(envelope.rpcId, rpcId);
  assert.ok(envelope.result && typeof envelope.result === 'object');
  const result = envelope.result;
  if (result.ok === true) return { ok: true, value: result.value };
  assert.equal(result.ok, false);
  assert.ok(result.error && typeof result.error === 'object' && !Array.isArray(result.error));
  assert.equal(typeof result.error.code, 'string');
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.details && typeof result.error.details === 'object' && !Array.isArray(result.error.details));
  return result;
}
function registeredTransport(handler) {
  const routes = new Map();
  const removed = [];
  const dispose = registerTransport({ fetch: { register(route) {
    assert.deepEqual(route.methods, ['POST']);
    assert.equal(route.requestBody, 'buffered');
    assert.ok(!routes.has(route.path));
    routes.set(route.path, route);
    return () => { removed.push(route.path); routes.delete(route.path); };
  } } }, handler);
  return { routes, removed, dispose };
}
function request(route, { payload = {}, rpcId = 'synthetic-rpc-id', body, headers = {}, signal } = {}) {
  const method = route.path.slice('/api/'.length);
  return new Request(`http://127.0.0.1${route.path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: body ?? JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    ...(signal ? { signal } : {}),
  });
}

for (const [format, shape] of [
  ['flat', (c) => ({ access_token: c.access, refresh_token: c.refresh, account_id: c.accountId, email: c.email })],
  ['array', (c) => [{ access_token: c.access, refresh_token: c.refresh, account_id: c.accountId, email: c.email }]],
  ['accounts wrapper', (c) => ({ format: 'dsh-codex-accounts', version: 1, accounts: [{ credential: c }] })],
  ['Codex CLI tokens', (c) => ({ tokens: { access_token: c.access, refresh_token: c.refresh, account_id: c.accountId }, email: c.email })],
  ['DSH credential', (c) => ({ credential: c })],
]) {
  test(`[FORMAT] accepts ${format}`, () => {
    const c = credential();
    const [item] = normalizeInput(`\uFEFF ${JSON.stringify(shape(c))} `, NOW);
    assert.equal(item.credential.type, 'oauth');
    assert.equal(item.credential.access, c.access);
    assert.equal(item.credential.refresh, c.refresh);
    assert.equal(item.credential.accountId, c.accountId);
    assert.equal(item.credential.expires, EXP_SECONDS * 1000);
    assert.equal(item.credential.email, c.email);
    assert.ok(item.label.length > 0 && item.label.length <= 48);
  });
}

test('[FORMAT] expiry uses JWT seconds, accepts explicit times, never invents freshness', () => {
  const withJwt = normalizeInput(JSON.stringify({ credential: { ...credential(), expires: 1 } }), NOW)[0];
  assert.equal(withJwt.credential.expires, EXP_SECONDS * 1000);
  for (const expires of [EXP_SECONDS, EXP_SECONDS * 1000, '2100-01-01T00:00:00Z']) {
    const [item] = normalizeInput(JSON.stringify({ access_token: 'synthetic-opaque-access', refresh_token: 'synthetic-opaque-refresh', expires }), NOW);
    assert.equal(item.credential.expires, EXP_SECONDS * 1000);
  }
  const [unknown] = normalizeInput(JSON.stringify({ access_token: 'synthetic-opaque-access', refresh_token: 'synthetic-opaque-refresh' }), NOW);
  assert.equal(unknown.credential.expires, 0);
  assert.ok(unknown.warnings.some((message) => message.includes('无法确定')));
  assert.deepEqual(claims('not-a-jwt'), {});
});

test('[FORMAT] labels normalize whitespace, bound length, and public labels are masked', () => {
  const [spaced] = normalizeInput(incoming(credential(), '  My   saved\n account  '), NOW);
  assert.equal(spaced.label, 'My saved account');
  assert.equal(normalizeInput(incoming(credential(), 'X'.repeat(80)), NOW)[0].label.length, 48);
  assert.equal(maskLabel('alice@example.invalid'), 'a***@example.invalid');
  assert.equal(maskLabel('Private label'), 'Pr***');
});

for (const [name, input, code] of [
  ['invalid JSON', '{', 'INVALID_JSON'],
  ['null', 'null', 'INVALID_ITEM'],
  ['empty batch', '[]', 'ACCOUNT_COUNT'],
  ['missing refresh', JSON.stringify({ access_token: 'synthetic-access' }), 'INVALID_CREDENTIAL'],
  ['embedded token whitespace', JSON.stringify({ access_token: 'synthetic access', refresh_token: 'synthetic-refresh' }), 'INVALID_CREDENTIAL'],
  ['wrong id token type', JSON.stringify({ credential: { ...credential(), idToken: 12 } }), 'INVALID_CREDENTIAL'],
  ['non-OAuth credential type', JSON.stringify({ credential: { ...credential(), type: 'api-key' } }), 'INVALID_CREDENTIAL'],
  ['invalid token account claim', JSON.stringify({ credential: { ...credential(), accountId: undefined, access: jwt({ team: { invalid: true } }) } }), 'ACCOUNT_ID'],
  ['account mismatch', JSON.stringify({ credential: { ...credential(), accountId: 'another-team' } }), 'ACCOUNT_MISMATCH'],
  ['redacted backup', JSON.stringify({ redacted: true, accounts: [] }), 'REDACTED'],
  ['unsupported backup version', JSON.stringify({ format: 'dsh-codex-accounts', version: 2, accounts: [] }), 'INPUT_VERSION'],
  ['oversized text', ' '.repeat(MAX_BYTES + 1), 'INPUT_SIZE'],
  ['too many accounts', JSON.stringify(Array.from({ length: MAX_ACCOUNTS + 1 }, () => ({ credential: credential() }))), 'ACCOUNT_COUNT'],
]) {
  test(`[VALIDATION] rejects ${name}`, () => { assert.throws(() => normalizeInput(input, NOW), hasCode(code)); });
}

test('[IDENTITY] rejects duplicate batch identities even with rotated access tokens', () => {
  const items = [{ credential: credential() }, { credential: credential({ salt: 'rotated' }) }];
  assert.throws(() => normalizeInput(JSON.stringify(items), NOW), hasCode('BATCH_DUPLICATE'));
});

test('[IDENTITY] team account ID alone never merges different users', () => {
  const alice = credential({ user: 'alice', subject: 'shared-sub' });
  const bob = credential({ user: 'bob', subject: 'shared-sub', salt: 'bob' });
  assert.equal(sameAccount(alice, bob), false);
  assert.equal(normalizeInput(JSON.stringify([{ credential: alice }, { credential: bob }]), NOW).length, 2);
  assert.equal(sameAccount(alice, credential({ user: 'alice', subject: 'different-sub', salt: 'renewed' })), true);
  assert.equal(sameAccount(credential({ user: null }), credential({ user: null, salt: 'rotated' })), true);
  assert.equal(sameAccount(credential({ user: null }), credential({ user: null, subject: 'other-user', salt: 'rotated' })), false);
  assert.equal(sameAccount(credential(), credential({ team: 'other-team', salt: 'rotated' })), false);
  assert.equal(sameAccount({ access: 'same-opaque' }, { access: 'same-opaque' }), true);
  assert.equal(sameAccount({ access: 'opaque-a', accountId: 'same-team' }, { access: 'opaque-b', accountId: 'same-team' }), false);
});

test('[FILE UNIT] temporary adapter queues real disk transactions and undefined is no write', async (t) => {
  const f = await fixture(t, vault());
  const first = f.credentials.modifyRecord(VAULT_KEY, async (current) => ({ ...current, payload: { ...current.payload, counter: 1 } }));
  const second = f.credentials.modifyRecord(VAULT_KEY, (current) => ({ ...current, payload: { ...current.payload, counter: current.payload.counter + 1 } }));
  await Promise.all([first, second]);
  assert.equal((await f.readDocument()).records[VAULT_KEY].payload.counter, 2);
  const before = await f.bytes();
  assert.equal((await f.credentials.modifyRecord(VAULT_KEY, () => undefined)).payload.counter, 2);
  assert.equal(await f.bytes(), before);
  assert.deepEqual(f.writes, { records: 2, refs: 0 });
});

test('[FILE UNIT] readVault reconciles externally changed disk rather than stale readRecord cache', async (t) => {
  const original = vault();
  const f = await fixture(t, original);
  const changed = clone(original);
  changed.payload.accounts[0].credential.refresh = 'synthetic-external-rotation';
  await f.externalReplace(changed);
  assert.equal((await f.credentials.readRecord(VAULT_KEY)).payload.accounts[0].credential.refresh, original.payload.accounts[0].credential.refresh);
  assert.equal((await readVault(f.credentials)).payload.accounts[0].credential.refresh, 'synthetic-external-rotation');
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});

test('[FILE UNIT] fresh vault preview is read-only and first import chooses a valid active ID', async (t) => {
  const f = await fixture(t);
  const text = incoming();
  const before = await f.bytes();
  const preview = await previewImport(f.credentials, text);
  assert.match(preview.revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual([preview.added, preview.updated, preview.skipped, preview.total], [1, 0, 0, 1]);
  assert.equal(await f.bytes(), before);
  assert.equal(JSON.stringify(preview).includes(credential().refresh), false);
  assert.equal(JSON.stringify(preview).includes(credential().access), false);
  const result = await importAccounts(f.credentials, { text, revision: preview.revision });
  assert.equal(result.added, 1);
  const saved = (await f.readDocument()).records[VAULT_KEY];
  validateRecord(saved);
  assert.equal(saved.payload.accounts.length, 1);
  assert.equal(saved.payload.activeId, saved.payload.accounts[0].id);
  assert.deepEqual(f.writes, { records: 1, refs: 0 });
});

test('[FILE UNIT] same team different user adds a row and preserves active account', async (t) => {
  const seed = vault([account('alice', { user: 'alice', subject: 'shared-sub' })]);
  const f = await fixture(t, seed);
  const text = incoming(credential({ user: 'bob', subject: 'shared-sub', salt: 'bob' }), 'Bob');
  const preview = await previewImport(f.credentials, text);
  assert.equal(preview.added, 1);
  assert.equal(preview.updated, 0);
  await importAccounts(f.credentials, { text, revision: preview.revision });
  const saved = (await f.readDocument()).records[VAULT_KEY];
  assert.equal(saved.payload.accounts.length, 2);
  assert.deepEqual(saved.payload.accounts[0], seed.payload.accounts[0]);
  assert.equal(saved.payload.activeId, 'alice');
});

test('[FILE UNIT] stale preview after external rotation rejects without replacing bytes', async (t) => {
  const initial = vault();
  const f = await fixture(t, initial);
  const text = incoming(credential({ salt: 'intended-import' }));
  const preview = await previewImport(f.credentials, text);
  const rotated = clone(initial);
  rotated.payload.accounts[0].credential.refresh = 'synthetic-newer-external-refresh';
  await f.externalReplace(rotated);
  const before = await f.bytes();
  await assert.rejects(importAccounts(f.credentials, { text, revision: preview.revision }), hasCode('STALE_PREVIEW'));
  assert.equal(await f.bytes(), before);
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});

test('[FILE UNIT] import preserves active/legacy metadata and labels while synchronizing legacy ref', async (t) => {
  const alice = account('alice', { label: 'Original Alice', user: 'alice' });
  alice.credential.providerMetadata = { preserved: true };
  const bob = account('bob', { label: 'Original Bob', user: 'bob', salt: 'bob' });
  const seed = vault([alice, bob], { activeId: 'bob', legacyAccountId: 'alice', extraMetadata: { retained: ['value'] } });
  const f = await fixture(t, seed, { UNRELATED_SYNTHETIC_REF: 'keep-me' });
  const text = JSON.stringify([
    { label: 'Do not replace Alice label', credential: credential({ user: 'alice', salt: 'rotated' }) },
    { label: '  New   Carol  ', credential: credential({ user: 'carol', salt: 'carol' }) },
  ]);
  const preview = await previewImport(f.credentials, text);
  assert.deepEqual([preview.added, preview.updated], [1, 1]);
  const result = await importAccounts(f.credentials, { text, revision: preview.revision });
  assert.equal(result.activePreserved, true);
  assert.deepEqual(result.warnings, []);
  const document = await f.readDocument(), saved = document.records[VAULT_KEY];
  assert.equal(saved.payload.activeId, 'bob');
  assert.equal(saved.payload.legacyAccountId, 'alice');
  assert.deepEqual(saved.payload.extraMetadata, seed.payload.extraMetadata);
  assert.deepEqual(saved.payload.accounts[1], bob);
  assert.equal(saved.payload.accounts[0].label, 'Original Alice');
  assert.deepEqual(saved.payload.accounts[0].note, alice.note);
  assert.deepEqual(saved.payload.accounts[0].credential.providerMetadata, { preserved: true });
  assert.equal(saved.payload.accounts[2].label, 'New Carol');
  assert.deepEqual(JSON.parse(document.refs.OPENAI_CODEX_SUBSCRIPTION_OAUTH), saved.payload.accounts[0].credential);
  assert.equal(document.refs.UNRELATED_SYNTHETIC_REF, 'keep-me');
  assert.deepEqual(f.writes, { records: 1, refs: 1 });
});

test('[FILE UNIT] unchanged reimport skips without record or legacy-reference writes', async (t) => {
  const saved = account('alice');
  const f = await fixture(t, vault([saved], { legacyAccountId: 'alice' }));
  const text = incoming(saved.credential, 'A new label is not an explicit rename');
  const preview = await previewImport(f.credentials, text);
  assert.deepEqual([preview.added, preview.updated, preview.skipped], [0, 0, 1]);
  const before = await f.bytes();
  const result = await importAccounts(f.credentials, { text, revision: preview.revision });
  assert.equal(result.skipped, 1);
  assert.equal(await f.bytes(), before);
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});

test('[FILE UNIT] malformed stored vaults and ambiguous identities are never overwritten', async (t) => {
  const cases = [
    { kind: 'api-key', key: 'synthetic-not-a-vault' },
    vault([account()], { version: 2 }),
    vault([account()], { activeId: 'missing' }),
    vault([account()], { legacyAccountId: 'missing' }),
    vault([account(), account()]),
    vault([{ ...account(), label: ' ' }]),
  ];
  for (const seed of cases) {
    const f = await fixture(t, seed);
    const before = await f.bytes();
    await assert.rejects(previewImport(f.credentials, incoming()), hasCode('VAULT_FORMAT'));
    await assert.rejects(importAccounts(f.credentials, { text: incoming(), revision: '0'.repeat(64) }), hasCode('VAULT_FORMAT'));
    assert.equal(await f.bytes(), before);
    assert.deepEqual(f.writes, { records: 0, refs: 0 });
  }
  const f = await fixture(t, vault([account('one'), account('two', { salt: 'second-existing-copy' })]));
  const before = await f.bytes();
  await assert.rejects(previewImport(f.credentials, incoming()), hasCode('AMBIGUOUS_ACCOUNT'));
  assert.equal(await f.bytes(), before);
});

test('[FILE UNIT] invalid batch or absent preview cannot partially import', async (t) => {
  const f = await fixture(t, vault());
  const before = await f.bytes();
  const invalid = JSON.stringify([{ credential: credential({ user: 'new', salt: 'new' }) }, { access_token: 'missing-refresh' }]);
  await assert.rejects(previewImport(f.credentials, invalid), hasCode('INVALID_CREDENTIAL'));
  await assert.rejects(importAccounts(f.credentials, { text: invalid, revision: '0'.repeat(64) }), hasCode('INVALID_CREDENTIAL'));
  await assert.rejects(importAccounts(f.credentials, { text: incoming() }), hasCode('PREVIEW_REQUIRED'));
  const duplicate = JSON.stringify([{ credential: credential() }, { credential: credential({ salt: 'rotation' }) }]);
  await assert.rejects(importAccounts(f.credentials, { text: duplicate, revision: '0'.repeat(64) }), hasCode('BATCH_DUPLICATE'));
  assert.equal(await f.bytes(), before);
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});

test('[FILE UNIT] post-commit legacy sync failure warns without pretending import rolled back', async (t) => {
  const f = await fixture(t, vault([account('alice')], { legacyAccountId: 'alice' }));
  const credentials = { ...f.credentials, set: async () => { throw new Error('synthetic-storage-failure-never-echo'); } };
  const text = incoming(credential({ salt: 'updated' }));
  const preview = await previewImport(credentials, text);
  const result = await importAccounts(credentials, { text, revision: preview.revision });
  assert.equal(result.updated, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-storage-failure-never-echo'), false);
  assert.equal((await f.readDocument()).records[VAULT_KEY].payload.accounts[0].credential.refresh, 'synthetic-refresh-updated');
  assert.equal(f.writes.records, 1);
});

test('[FILE UNIT] listing masks identities and exports only the explicitly selected accounts', async (t) => {
  const alice = account('alice', { label: 'alice@example.invalid' });
  alice.credential.idToken = jwt({ salt: 'synthetic-id-token' });
  const bob = account('bob', { user: 'bob', salt: 'bob', label: 'Private Bob' });
  const f = await fixture(t, vault([alice, bob], { activeId: 'bob' }));
  const before = await f.bytes();
  const listed = await listAccounts(f.credentials);
  assert.deepEqual(listed.accounts.map((a) => [a.id, a.label, a.active]), [['alice', 'a***@example.invalid', false], ['bob', 'Pr***', true]]);
  const redacted = await exportAccounts(f.credentials, { ids: ['alice'] });
  assert.equal(redacted.format, 'dsh-codex-accounts');
  assert.equal(redacted.version, 1);
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.accounts.length, 1);
  assert.equal(redacted.accounts[0].label, 'a***@example.invalid');
  assert.deepEqual(Object.keys(redacted.accounts[0]).sort(), ['expires', 'label', 'type']);
  const publicText = JSON.stringify({ listed, redacted });
  for (const value of [alice.credential.access, alice.credential.refresh, alice.credential.idToken, bob.credential.access]) assert.equal(publicText.includes(value), false);
  assert.throws(() => normalizeInput(JSON.stringify(redacted), NOW), hasCode('REDACTED'));
  const full = await exportAccounts(f.credentials, { ids: ['alice'], includeSecrets: true, confirmed: true });
  assert.equal(full.redacted, false);
  assert.equal(full.accounts[0].label, alice.label);
  assert.equal(full.accounts[0].access_token, alice.credential.access);
  assert.equal(full.accounts[0].refresh_token, alice.credential.refresh);
  assert.equal(full.accounts[0].id_token, alice.credential.idToken);
  assert.equal(full.accounts[0].account_id, alice.credential.accountId);
  assert.equal(full.accounts[0].email, alice.credential.email);
  assert.equal(normalizeInput(JSON.stringify(full), NOW).length, 1);
  assert.equal(await f.bytes(), before);
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});

test('[FILE UNIT] export requires a valid unique selection and explicit full-backup confirmation', async (t) => {
  const f = await fixture(t, vault([account('alice')]));
  for (const ids of [undefined, [], [3], ['alice', 'alice']]) await assert.rejects(exportAccounts(f.credentials, { ids }), hasCode('SELECTION'));
  await assert.rejects(exportAccounts(f.credentials, { ids: ['missing'] }), hasCode('SELECTION_CHANGED'));
  await assert.rejects(exportAccounts(f.credentials, { ids: ['alice'], includeSecrets: true }), hasCode('CONFIRM_EXPORT'));
  await assert.rejects(exportAccounts(f.credentials, { ids: ['alice'], includeSecrets: true, confirmed: 'yes' }), hasCode('CONFIRM_EXPORT'));
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});

test('[REQUEST UNIT] all endpoints return browser-compatible envelopes over real Requests', async (t) => {
  const f = await fixture(t);
  const transport = registeredTransport(createHandler(f.credentials));
  t.after(transport.dispose);
  assert.equal(transport.routes.size, ENDPOINTS.length);
  const call = async (endpoint, payload = {}) => {
    const route = transport.routes.get(`/api/codex-account-tools/${endpoint}`);
    const rpcId = `synthetic-${endpoint}`;
    const response = await route.fetch(request(route, { payload, rpcId }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    return browserResult(await response.json(), rpcId);
  };
  const listed = await call('accounts/list');
  assert.equal(listed.ok, true);
  assert.equal(listed.value.total, 0);
  const text = incoming();
  const preview = await call('accounts/preview', { text });
  assert.equal(preview.ok, true);
  const imported = await call('accounts/import', { text, revision: preview.value.revision });
  assert.equal(imported.ok, true);
  assert.equal(imported.value.added, 1);
  const after = await call('accounts/list');
  const exported = await call('accounts/export', { ids: [after.value.accounts[0].id] });
  assert.equal(exported.ok, true);
  assert.equal(exported.value.redacted, true);
  const failed = await call('accounts/preview', { text: '{' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'INVALID_JSON');
  assert.deepEqual(failed.error.details, {});
});

test('[REQUEST UNIT] malformed RPC envelopes and bodies never dispatch or write', async (t) => {
  let dispatches = 0;
  const transport = registeredTransport(async () => { dispatches += 1; return { ok: true, value: {} }; });
  t.after(transport.dispose);
  const route = transport.routes.get('/api/codex-account-tools/accounts/list');
  const valid = { type: 'client-request', rpcId: 'synthetic-id', method: 'codex-account-tools/accounts/list', payload: {} };
  for (const body of [
    null, {}, { ...valid, type: 'request' }, { ...valid, rpcId: undefined },
    { ...valid, rpcId: 7 }, { ...valid, rpcId: '' }, { ...valid, rpcId: 'x'.repeat(257) },
    { ...valid, method: 'codex-account-tools/accounts/export' },
  ]) assert.equal((await route.fetch(request(route, { body: JSON.stringify(body) }))).status, 400);
  assert.equal((await route.fetch(request(route, { body: '{' }))).status, 400);
  assert.equal((await route.fetch(request(route, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await route.fetch(request(route, { headers: { 'content-length': String(MAX_BYTES + 65537) } }))).status, 413);
  assert.equal((await route.fetch(request(route, { body: ' '.repeat(MAX_BYTES + 65537) }))).status, 413);
  assert.equal(dispatches, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(route.fetch(request(route, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(dispatches, 0);
});

test('[REQUEST UNIT] arbitrary storage exceptions stay inside the typed error result', async (t) => {
  const f = await fixture(t, vault());
  const unavailable = { ...f.credentials, modifyRecord: async () => { throw new Error('synthetic-internal-message-must-not-leak'); } };
  const transport = registeredTransport(createHandler(unavailable));
  t.after(transport.dispose);
  const route = transport.routes.get('/api/codex-account-tools/accounts/list');
  const response = await route.fetch(request(route));
  const text = await response.text();
  assert.equal(text.includes('synthetic-internal-message-must-not-leak'), false);
  assert.equal(browserResult(JSON.parse(text), 'synthetic-rpc-id').error.code, 'STORAGE');
  for (const payload of [null, [], 'text']) assert.equal((await createHandler(f.credentials)('accounts/list', payload)).error.code, 'INPUT');
  assert.equal((await createHandler(f.credentials)('unknown', {})).error.code, 'ENDPOINT');
});

test('[REQUEST UNIT] transport disposes routes in reverse order and rolls back partial registration', () => {
  const transport = registeredTransport(async () => ({ ok: true, value: {} }));
  const paths = [...transport.routes.keys()];
  transport.dispose();
  assert.equal(transport.routes.size, 0);
  assert.deepEqual(transport.removed, [...paths].reverse());
  const disposed = [];
  let count = 0;
  assert.throws(() => registerTransport({ fetch: { register(route) {
    if (++count === 3) throw new Error('synthetic-registration-failure');
    return () => disposed.push(route.path);
  } } }, async () => ({ ok: true, value: {} })), /synthetic-registration-failure/u);
  assert.deepEqual(disposed, paths.slice(0, 2).reverse());
});

test('[CLIENT + REQUEST UNIT] actual slot-injected call crosses the strict Request bridge, not a Cordis ctx prop', async (t) => {
  const f = await fixture(t, vault());
  const server = registeredTransport(createHandler(f.credentials));
  t.after(server.dispose);
  let definition;
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
    AbortController, setTimeout, clearTimeout,
  }, { filename: 'account-tools-client-fixture.js' });
  assert.equal(definition.id, 'dsh-codex-account-tools');
  // Do not render React or run DOM effects: only observe its real apply/slot wiring.
  const client = definition.factory((name) => { assert.equal(name, 'react'); return { createElement() {} }; });
  const registrations = [];
  const rpc = { async call(channel, endpoint, payload, signal) {
    assert.equal(channel, '/api');
    const route = server.routes.get(`${channel}/${endpoint}`);
    assert.ok(route);
    const rpcId = randomUUID();
    const response = await route.fetch(request(route, { payload, rpcId, signal }));
    if (!response.ok) throw new Error(`synthetic HTTP ${response.status}`);
    return browserResult(await response.json(), rpcId);
  } };
  client.apply({
    get(name) { assert.equal(name, 'connection'); return { rpc }; },
    effect() { return () => {}; },
    inject() {},
    slots: {
      inject(name, install) { return install(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  });
  const settings = registrations.find((r) => r.options.name === 'settings.section');
  const bundle = registrations.find((r) => r.options.name === 'plugins.bundle.config');
  assert.equal(settings.options.id, 'codex-account-tools');
  assert.equal(bundle.options.key, 'dsh-codex-account-tools');
  const props = settings.options.inject();
  assert.equal(typeof props.call, 'function');
  assert.equal(bundle.options.inject().embedded, true);
  const value = await props.call('accounts/list');
  assert.equal(value.total, 1);
  assert.equal(value.accounts[0].active, true);
  await assert.rejects(props.call('accounts/preview', { text: '{' }), /JSON/u);
  assert.deepEqual(f.writes, { records: 0, refs: 0 });
});
