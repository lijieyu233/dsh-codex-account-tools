import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const filename = `${manifest.name}-${manifest.version}.tgz`;
const archive = join(root, 'release', filename);
const zipped = await readFile(archive);
const tar = gunzipSync(zipped, { maxOutputLength: 4 * 1024 * 1024 });
const allowed = new Set(['package/package.json', 'package/LICENSE', 'package/cordis.patch.yml', 'package/compatibility.json', 'package/README.md', 'package/PUBLISHING.md', 'package/lib/index.js', 'package/lib/client.js', 'package/lib/vault.js']);
const entries = new Map();
const str = (b) => b.toString('utf8').replace(/\0.*$/su, '');
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((b) => b === 0)) break;
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
  assert.equal(checksum, parseInt(str(header.subarray(148, 156)).trim(), 8), 'Invalid tar checksum');
  const prefix = str(header.subarray(345, 500)), name = str(header.subarray(0, 100));
  const path = prefix ? `${prefix}/${name}` : name;
  const size = parseInt(str(header.subarray(124, 136)).trim() || '0', 8);
  assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar size');
  const type = String.fromCharCode(header[156]);
  assert.ok(type === '0' || type === '\0', `Non-file tar entry rejected: ${path}`);
  assert.ok(allowed.has(path), `Unexpected release content: ${path}`);
  assert.ok(!entries.has(path), 'Duplicate tar entry');
  const data = tar.subarray(offset + 512, offset + 512 + size);
  entries.set(path, data);
  offset += 512 + Math.ceil(size / 512) * 512;
}
assert.equal(entries.size, allowed.size, 'Missing release files');
const sensitivePatterns = [
  /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{10,}/u,
  /Bearer\s+[A-Za-z0-9._-]{40,}/u,
  /(?:rt_|sk-)[A-Za-z0-9_-]{40,}/u,
  /[a-z]:[\\/]Users[\\/](?!Public(?:[\\/]|$)|Default(?:[\\/]|$))[^\s"'<>/\\]+[\\/]/iu,
  /[a-z]:[\\/](?:document[\\/]code|workspace|projects)[\\/]/iu,
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:icloud|gmail|outlook|hotmail)\.com/iu,
];
for (const [path, bytes] of entries) {
  assert.deepEqual(bytes, await readFile(join(root, path.slice('package/'.length))), `Release differs from source: ${path}`);
  assert.ok(!bytes.includes(Buffer.from([0xef, 0xbf, 0xbd])), `Replacement character in ${path}`);
  for (const pattern of sensitivePatterns) assert.ok(!pattern.test(bytes.toString('utf8')), `Potential sensitive content rejected: ${path}`);
}
const pkg = JSON.parse(entries.get('package/package.json'));
assert.equal(pkg.name, 'dsh-codex-account-tools');
assert.equal(pkg.version, '1.1.0');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.repository.url, 'git+https://github.com/lijieyu233/dsh-codex-account-tools.git');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.ok(!pkg.scripts?.[hook], 'Unexpected lifecycle hook');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.ok(entries.has(`package/${pkg.main.replace(/^\.\//u, '')}`));
assert.ok(entries.has(`package/${pkg.exports['./client'].replace(/^\.\//u, '')}`));
const compatibility = JSON.parse(entries.get('package/compatibility.json'));
assert.ok(compatibility.supported.includes('0.2.1-rc.2'));

const temporary = await mkdtemp(join(tmpdir(), 'dsh-codex-release-verify-'));
assert.equal(dirname(temporary), resolve(tmpdir()));
assert.ok(basename(temporary).startsWith('dsh-codex-release-verify-'));
let smoke;
try {
  for (const [path, bytes] of entries) {
    const dest = join(temporary, path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
  const server = await import(pathToFileURL(join(temporary, 'package/lib/index.js')));
  const routes = new Map();
  const credentials = {
    // Deliberately empty, isolated adapter: smoke test must never read a DSH home.
    modifyRecord: async (_key, mutate) => { assert.equal(await mutate(undefined), undefined); return undefined; }
  };
  const dispose = server.registerTransport({ fetch: { register: (route) => {
    routes.set(route.path, route); return () => routes.delete(route.path);
  } } }, server.createHandler(credentials));
  const route = routes.get('/api/codex-account-tools/accounts/list');
  const method = route.path.slice('/api/'.length);
  const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'release-smoke', method, payload: {} }) }));
  const envelope = await response.json();
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.rpcId, 'release-smoke');
  assert.equal(envelope.result.ok, true);
  assert.equal(envelope.result.value.total, 0);
  dispose(); assert.equal(routes.size, 0);
  let registration;
  vm.runInNewContext(entries.get('package/lib/client.js').toString('utf8'), {
    window: { __ModuleLoader__: { load: (value) => { registration = value; } } }
  });
  assert.equal(registration.id, pkg.name);
  const client = registration.factory((dependency) => { assert.equal(dependency, 'react'); return {}; });
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(Array.from(client.inject), ['slots', 'connection']);
  smoke = { extractedServer: 'passed', extractedRpc: 'passed', extractedClientRegistration: 'passed' };
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const sha256 = createHash('sha256').update(zipped).digest('hex');
const report = { file: filename, bytes: zipped.length, sha256, fileCount: entries.size, files: [...entries.keys()].sort(), sensitivePatternScan: 'passed', sourceComparison: 'passed', ...smoke, note: 'Packaging smoke checks supplement, not replace, the real Electron verification already performed for this runtime version.' };
await writeFile(join(root, 'release', `${filename}.sha256`), `${sha256}  ${filename}\n`, 'utf8');
await writeFile(join(root, 'release', 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
