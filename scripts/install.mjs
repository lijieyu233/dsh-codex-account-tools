import { mkdir, readFile, writeFile, copyFile, rename, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = join(homedir(), '.dsh', 'profiles', 'desktop');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const name = pkg.name;
if (name !== 'dsh-codex-account-tools') throw new Error('Unexpected package name.');
const target = resolve(profile, 'node_modules', name);
if (target !== resolve(homedir(), '.dsh/profiles/desktop/node_modules/dsh-codex-account-tools')) throw new Error('Unexpected installation target.');
const configPath = join(profile, 'package.json');
const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/u, ''));
if (!Array.isArray(config.dsh?.profile?.bundles)) throw new Error('Invalid profile manifest.');
const subscription = JSON.parse(await readFile(join(profile, 'node_modules/dsh-codex-subscription/package.json'), 'utf8'));
const subscriptionVersion = /^3\.(\d+)\.(\d+)$/u.exec(subscription.version);
if (!subscriptionVersion || Number(subscriptionVersion[1]) < 2 || (Number(subscriptionVersion[1]) === 2 && Number(subscriptionVersion[2]) < 6)) throw new Error('This companion requires subscription plugin >=3.2.6 <4 (stable releases).');
const files = ['package.json', 'cordis.patch.yml', 'compatibility.json', 'README.md', 'PUBLISHING.md', 'LICENSE', 'lib/index.js', 'lib/vault.js', 'lib/client.js'];
for (const file of files) await access(join(root, file));
const backup = join(root, 'backups', new Date().toISOString().replace(/[:.]/gu, '-'));
await mkdir(backup, { recursive: true });
await copyFile(configPath, join(backup, 'profile-package.json'));
for (const file of files) {
  const dest = join(backup, 'plugin', file);
  await mkdir(dirname(dest), { recursive: true });
  try { await copyFile(join(target, file), dest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const file of files) {
  const dest = join(target, file);
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.account-tools-tmp`;
  await copyFile(join(root, file), temp);
  await rename(temp, dest);
}
// Pin the durable source as a local dependency, rather than a nonexistent registry release.
config.dependencies ??= {};
config.dependencies[name] = `file:${root.replace(/\\/gu, '/')}`;
if (!config.dsh.profile.bundles.includes(name)) config.dsh.profile.bundles.push(name);
const temp = `${configPath}.account-tools-tmp`;
await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
await rename(temp, configPath);
console.log(`Installed ${name} ${pkg.version}; bundles=${config.dsh.profile.bundles.length}; existing accounts untouched.`);
console.log(`Code/config backup: ${backup}`);
console.log('Reload only this plugin through DSH plugin management, then refresh the existing GUI.');
