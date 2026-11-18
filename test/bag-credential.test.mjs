// bag-credential.test.mjs —— 凭据入口闸（v0.2.2 最小版）
//
// 覆盖：六类文本模式 + .env 文件名 + manifest 字段 + 干净样例不误伤
//      + --allow-credentials 放行路径（manifest.credentialOverride + outRoot/audit 留痕）
//      + --force 不放行（凭据闸优先于 persona 闸）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportBag, verifyBag } from '../tools/bag-export.mjs';
import { scanText, scanFileName, redact } from '../lib/credential-scan.mjs';

const quiet = () => {};
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `whale-cred-${n}-`));

function makeData(extra = {}, { journalFile = '2026-11-01.jsonl' } = {}) {
  const dir = tmp('data');
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  const base = {
    'memory.json': JSON.stringify([{ id: 'm1', text: '今天天气不错' }]),
    'facts.jsonl': '{"id":"f1","key":"city","value":"杭州"}\n',
    'longterm.json': JSON.stringify({ note: '普通长期记忆' }),
    'journal/2026-11-01.jsonl': '{"t":1,"text":"普通聊天"}\n',
  };
  for (const [rel, body] of Object.entries({ ...base, ...extra })) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (journalFile !== '2026-11-01.jsonl') {
    // 需要换 journal 文件名时，把默认那个挪走
    fs.rmSync(path.join(dir, 'journal', '2026-11-01.jsonl'), { force: true });
  }
  return dir;
}

async function run(dataDir, opts = {}) {
  const outRoot = tmp('out');
  const r = await exportBag({ dataDir, outRoot, yes: true, log: quiet, ...opts });
  return { r, outRoot };
}

const hasRule = (r, id) => (r.credentialHits ?? []).some((h) => h.rule === id);

test('reject：memory.json 里的 sk- API key', async () => {
  const data = makeData({ 'memory.json': JSON.stringify([{ id: 'm', text: 'key=sk-abcdefghijklmnop123456' }]) });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.ok(r.problems[0].includes('凭据'), r.problems[0]);
  assert.equal(hasRule(r, 'openai-key'), true);
});

test('reject：facts.jsonl 里的 AWS AKIA', async () => {
  const data = makeData({ 'facts.jsonl': '{"id":"f","note":"AKIAIOSFODNN7EXAMPLE"}\n' });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'aws-akid'), true);
});

test('reject：journal 里的 GitHub token', async () => {
  const data = makeData({ 'journal/2026-11-01.jsonl': '{"t":1,"text":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}\n' });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'github-token'), true);
});

test('reject：longterm.json 里的私钥块', async () => {
  const data = makeData({ 'longterm.json': JSON.stringify({ pem: '-----BEGIN RSA PRIVATE KEY-----' }) });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'private-key'), true);
});

test('reject：数据库连接串（postgres://）', async () => {
  const data = makeData({ 'memory.json': JSON.stringify([{ id: 'm', text: 'postgres://db.internal:5432/app' }]) });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'db-url'), true);
});

test('reject：URL 里内嵌密码（user:pass@）', async () => {
  const data = makeData({ 'facts.jsonl': '{"id":"f","url":"https://alice:hunter2@example.com/api"}\n' });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'url-basic-auth'), true);
});

test('reject：journal 目录里的 .env 文件名', async () => {
  const data = makeData({ 'journal/.env': 'FOO=bar\n' });
  const { r } = await run(data);
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'env-file'), true);
});

test('reject：provenance.note 里的 sk-（manifest 字段也扫）', async () => {
  const data = makeData();
  const { r } = await run(data, { provenance: { platform: 'qq', rescuer: '甲', note: '搬迁时带了 sk-zzzzzzzzzzzzzzzzzzzz' } });
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'openai-key'), true);
  assert.ok((r.credentialHits ?? []).some((h) => h.where === 'provenance.note'));
});

test('干净样例：不误伤，正常出袋且可 verify', async () => {
  const data = makeData();
  const { r } = await run(data);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.credentialHits.length, 0);
  assert.equal(fs.existsSync(r.dir), true);
  assert.equal(verifyBag(r.dir).ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.credentialOverride, undefined, '未放行时不该有 credentialOverride 字段');
});

test('放行：--allow-credentials 写出袋，manifest 留痕，outRoot/audit 追加一行', async () => {
  const data = makeData({ 'memory.json': JSON.stringify([{ id: 'm', text: 'key=sk-abcdefghijklmnop123456' }]) });
  const { r, outRoot } = await run(data, { allowCredentials: true });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.credentialOverride.reason, '--allow-credentials');
  assert.ok(manifest.credentialOverride.hits.length >= 1);
  assert.ok(manifest.credentialOverride.hits[0].sample.includes('…'), '样本必须脱敏');

  const audit = path.join(outRoot, 'audit', 'export-credentials.jsonl');
  assert.equal(fs.existsSync(audit), true, '审计文件应存在');
  const line = JSON.parse(fs.readFileSync(audit, 'utf8').trim().split('\n').pop());
  assert.equal(line.bag, r.dir);
  assert.ok(line.hits.length >= 1);
});

test('--force（含 personas）不放行凭据：闸在 persona 闸之前生效', async () => {
  const data = makeData({
    'personas.json': JSON.stringify({ rev: 1, personas: { a: {} } }),
    'memory.json': JSON.stringify([{ id: 'm', text: 'sk-abcdefghijklmnop123456' }]),
  });
  const { r } = await run(data, { includePersonas: true });
  assert.equal(r.ok, false);
  assert.equal(hasRule(r, 'openai-key'), true);
});

test('scanText / scanFileName / redact 单测', () => {
  assert.equal(scanText('-----BEGIN OPENSSH PRIVATE KEY-----').length, 1);
  assert.equal(scanText('hello world').length, 0);
  assert.equal(scanFileName('journal/.env').length, 1);
  assert.equal(scanFileName('journal/2026-11-01.jsonl').length, 0);
  assert.equal(redact('sk-abcdefghijklmnop'), 'sk-a…op');
});
