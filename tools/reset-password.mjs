// 重置某个账号的口令。
//
//   node tools/reset-password.mjs <用户名> [新口令]
//
// 不传新口令就自动生成一个足够随机的，并打印出来。
// 直接改 users.json 里的 salt/hash，所以必须先停掉服务再跑，避免被内存里的旧副本覆盖。
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generatePassword(length = 20) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

function usersPath() {
  if (process.env.USERS_FILE) return resolve(process.env.USERS_FILE);
  const dir = process.env.PERSIST_DIR || process.env.DATA_DIR || 'data';
  return resolve(dir, 'users.json');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [username, provided] = process.argv.slice(2);
if (!username) {
  fail('用法: node tools/reset-password.mjs <用户名> [新口令]');
}

const file = usersPath();
let parsed;
try {
  parsed = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  fail(`读不到 ${file}：${error.message}`);
}

const users = Array.isArray(parsed.users) ? parsed.users : [];
const name = String(username).trim().toLowerCase();
const user = users.find((entry) => entry.username === name);
if (!user) {
  fail(`没有这个账号：${name}\n现有账号：${users.map((entry) => entry.username).join(', ') || '（空）'}`);
}

const password = provided || generatePassword();
if (password.length < 8) fail('新口令至少 8 位');

const salt = randomBytes(16);
user.salt = salt.toString('hex');
user.hash = scryptSync(password, salt, 32).toString('hex');

writeFileSync(file, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
console.log(`已重置 ${name} 的口令`);
console.log(`  用户名: ${name}`);
console.log(`  新口令: ${password}`);
console.log(`  文件:   ${file}`);
console.log('');
console.log('如果服务正在运行，现在去重启一次，新口令才会生效。');
console.log(`  cd ${repoRoot} && node server/index.js`);
