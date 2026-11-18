// bag-manifest.test.mjs —— 钉住 0.2.1 已知边界：目录袋阶段 manifest 不自证
//
// ⚠️ 本测试钉住 0.2.1 已知边界（见 docs/KNOWN-ISSUES.md），0.2.2 实施后本文件改写为正向测试。
//
// 边界（见 docs/DESIGN.md §7「自证到哪、不到哪」）：
//   · 摘要锚 manifestSha256 只在**打成 v2 容器时**生效，锁的是打包那一刻的 manifest 全文；
//   · 目录袋（未打包）阶段 manifest.json 是免哈希元数据：改 provenance / createdAt，
//     verifyBag 仍绿——逐件 sha256 只覆盖 files[] 里列的件，manifest 自己不进去；
//   · 把改过 manifest 的目录袋再打包，假档案会被一起锚进新容器（"洗白"），verifyContainer 也绿。
//
// 这不是修 bug：是把现状钉成"文档化行为"，防将来无意改变语义。
// 0.2.2 若把目录袋阶段纳入完整性保护（候选：旁挂 manifest.sha256 + verifyBag 链式核），
// 本文件第一条与第三条应改为"改 manifest 即红"的正向断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyBag } from '../lib/bag-import.mjs';
import { packBag, verifyContainer } from '../lib/bag-container.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `whale-manifest-${name}-`));
}

/** 造一个最小但合法的目录袋（manifest.files 列 memory/facts/journal，manifest 自身不列）。 */
function makeBag({ rescuer = '甲', createdAt = '2026-11-17T00:00:00Z' } = {}) {
  const dir = tmp('bag');
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify([{ id: 'm1' }]));
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), '{"id":"f1"}\n');
  fs.writeFileSync(path.join(dir, 'journal', '2026-11-01.jsonl'), '{"t":1}\n');

  const files = [];
  const walk = (d, base = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else files.push({ path: rel, bytes: fs.statSync(abs).size, sha256: sha(fs.readFileSync(abs)) });
    }
  };
  walk(dir);

  const manifest = {
    format: 'whale-bag',
    version: 0,
    createdAt,
    provenance: { platform: 'qq', rescuer, exportedAt: '2026-11-17T00:00:00Z' },
    completeness: 'full',
    files,
    sections: {
      memory: { file: 'memory.json', count: 1 },
      facts: { file: 'facts.jsonl', lines: 1 },
      journal: { dir: 'journal', files: 1, lines: 1 },
    },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const writeManifest = (dir, m) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));

/** 改容器 header 里的 manifest，但**不动** manifestSha256——模拟"打包后改档案"。 */
function tamperHeader(file, mutate) {
  const buf = fs.readFileSync(file);
  const PREFIX = 16;
  const version = buf.readUInt16LE(8);
  const headerLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(PREFIX, PREFIX + headerLen).toString('utf8'));
  mutate(header);
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  const pre = Buffer.alloc(PREFIX);
  Buffer.from('WHALEBAG', 'ascii').copy(pre, 0);
  pre.writeUInt16LE(version, 8);
  pre.writeUInt16LE(0, 10);
  pre.writeUInt32LE(hb.length, 12);
  const out = path.join(tmp('tampered'), 'x.whale_mem');
  fs.writeFileSync(out, Buffer.concat([pre, hb, buf.subarray(PREFIX + headerLen)]));
  return out;
}

test('目录袋：改 manifest 的 provenance / createdAt，verifyBag 仍绿（0.2.1 已知边界）', () => {
  const bag = makeBag({ rescuer: '甲' });
  assert.equal(verifyBag(bag).ok, true, '原袋应通过');

  const m = readManifest(bag);
  m.provenance.rescuer = '乙';
  m.createdAt = '2026-11-18T00:00:00Z';
  writeManifest(bag, m);

  const v = verifyBag(bag);
  assert.equal(v.ok, true, '目录袋阶段改 manifest 不检出（钉住现状）');
  assert.deepEqual(v.problems, []);
  assert.equal(readManifest(bag).provenance.rescuer, '乙', '假档案确实留在盘上');
});

test('对照：改 files[] 里的真件字节，verifyBag 必红（逐件 sha256 仍在守）', () => {
  const bag = makeBag();
  assert.equal(verifyBag(bag).ok, true);

  fs.appendFileSync(path.join(bag, 'memory.json'), ' ');

  const v = verifyBag(bag);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('大小不符') || p.includes('sha256 不符')), JSON.stringify(v.problems));
});

test('洗白：改过 manifest 的目录袋打包后 verifyContainer 绿，假档案被锚进容器', () => {
  const bag = makeBag({ rescuer: '甲' });
  const m = readManifest(bag);
  m.provenance.rescuer = '乙';
  writeManifest(bag, m);

  const file = path.join(tmp('packed'), 'bag.whale_mem');
  const r = packBag(bag, file);
  assert.equal(r.ok, true, JSON.stringify(r.problems));

  const c = verifyContainer(file);
  assert.equal(c.ok, true);
  assert.equal(c.manifestAnchored, true, '应打成 v2（带 manifestSha256）');
  assert.equal(c.manifest.provenance.rescuer, '乙', '容器把打包当时的假档案一起锚定');
});

test('对照：打包后改 header 里的 manifest，verifyContainer 必红（v2 摘要锚生效）', () => {
  const bag = makeBag();
  const file = path.join(tmp('packed'), 'bag.whale_mem');
  assert.equal(packBag(bag, file).ok, true);

  const bad = tamperHeader(file, (h) => {
    h.manifest.provenance.rescuer = '丙';
    h.manifest.createdAt = '2026-11-19T00:00:00Z';
  });
  const c = verifyContainer(bad);
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems, ['manifest 摘要锚不符（manifest 被改过）'], '只该锚红，件本身没动');
});
