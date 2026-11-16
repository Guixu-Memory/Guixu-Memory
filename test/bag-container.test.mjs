// bag-container.test.mjs —— 单文件容器（.whale_mem）：打包/校验/解包 + 篡改与路径穿越负向
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { packBag, unpackBag, verifyContainer } from '../lib/bag-container.mjs';
import { verifyBag as libVerifyBag } from '../lib/bag-import.mjs';
import { exportBag } from '../tools/bag-export.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const quiet = () => {};

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `whale-container-${name}-`));
}

function makeData(dir) {
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify([{ id: 'm1' }, { id: 'm2' }]));
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), '{"id":"f1"}\n{"id":"f2"}\n');
  fs.writeFileSync(path.join(dir, 'journal', '2026-11-01.jsonl'), '{"t":1}\n{"t":2}\n');
  fs.writeFileSync(path.join(dir, 'generation.json'), JSON.stringify({ current: { gen: 'gen-abc' }, history: [] }));
  return dir;
}

async function makeBag(name) {
  const data = makeData(tmp(name));
  const out = tmp('out');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, log: quiet });
  assert.equal(r.ok, true);
  return r.dir;
}

function readFiles(dir) {
  const out = {};
  const walk = (d, base = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, rel); else out[rel] = fs.readFileSync(abs);
    }
  };
  walk(dir);
  return out;
}

/** 手工造一个容器文件（用于负向用例）。 */
function craft(header, payload) {
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  const pre = Buffer.alloc(16);
  Buffer.from('WHALEBAG', 'ascii').copy(pre, 0);
  pre.writeUInt16LE(1, 8);
  pre.writeUInt16LE(0, 10);
  pre.writeUInt32LE(hb.length, 12);
  const f = path.join(tmp('craft'), 'x.whale_mem');
  fs.writeFileSync(f, Buffer.concat([pre, hb, payload]));
  return f;
}

function headerFor(files, generation = null) {
  const manifest = {
    format: 'whale-bag', version: 0, createdAt: '2026-11-16T00:00:00Z',
    generation, files, sections: {},
  };
  return {
    format: 'whale-bag', containerVersion: 1, createdAt: '2026-11-16T00:00:00Z',
    generation, manifest, files,
  };
}

test('packBag：目录袋 → 单文件，头/逐件 sha 校验通过，generation 落容器', async () => {
  const bag = await makeBag('pack');
  const file = path.join(tmp('packed'), 'bag.whale_mem');
  const r = packBag(bag, file);
  assert.equal(r.ok, true);
  assert.equal(r.files, 3);
  assert.ok(fs.existsSync(file));
  const v = verifyContainer(file);
  assert.equal(v.ok, true);
  assert.equal(v.generation, 'gen-abc');
  assert.equal(v.files, 3);
});

test('unpackBag：解包结果逐字节等于原袋，且通过 lib 的 verifyBag', async () => {
  const bag = await makeBag('round');
  const file = path.join(tmp('roundout'), 'bag.whale_mem');
  assert.equal(packBag(bag, file).ok, true);
  const dest = path.join(tmp('rounddest'), 'restored');
  const r = unpackBag(file, dest);
  assert.equal(r.ok, true);
  assert.equal(libVerifyBag(dest).ok, true);

  const a = readFiles(bag);
  const b = readFiles(dest);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const k of Object.keys(a)) assert.equal(Buffer.compare(a[k], b[k]), 0, k);
});

test('verifyContainer：payload 改 1 字节 → sha256 不符', async () => {
  const bag = await makeBag('tamper');
  const file = path.join(tmp('tamperout'), 'bag.whale_mem');
  packBag(bag, file);
  const buf = fs.readFileSync(file);
  const headerLen = buf.readUInt32LE(12);
  const payloadStart = 16 + headerLen;
  buf[payloadStart] = buf[payloadStart] ^ 0xff;
  fs.writeFileSync(file, buf);
  const v = verifyContainer(file);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /sha256 不符/);
});

test('verifyContainer：截断 → 拒（payload 长度不符）', async () => {
  const bag = await makeBag('trunc');
  const file = path.join(tmp('truncout'), 'bag.whale_mem');
  packBag(bag, file);
  fs.truncateSync(file, fs.statSync(file).size - 1);
  const v = verifyContainer(file);
  assert.equal(v.ok, false);
});

test('verifyContainer：magic 不对 → 拒', () => {
  const f = path.join(tmp('magic'), 'bad.whale_mem');
  fs.writeFileSync(f, Buffer.alloc(64));
  const v = verifyContainer(f);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /magic/);
});

test('verifyContainer：header 长度越过文件尾 → 拒', () => {
  const pre = Buffer.alloc(16);
  Buffer.from('WHALEBAG', 'ascii').copy(pre, 0);
  pre.writeUInt16LE(1, 8);
  pre.writeUInt32LE(999999, 12);
  const f = path.join(tmp('badlen'), 'bad.whale_mem');
  fs.writeFileSync(f, pre);
  const v = verifyContainer(f);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /header/);
});

test('verifyContainer：manifest.files 与容器 files 不一致 → 拒', () => {
  const body = Buffer.from('x');
  const files = [{ path: 'a.txt', bytes: 1, offset: 0, sha256: sha(body) }];
  const h = headerFor(files);
  h.manifest.files = [{ path: 'b.txt', bytes: 1, offset: 0, sha256: sha(body) }];
  const f = craft(h, body);
  const v = verifyContainer(f);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /不一致/);
});

test('verifyContainer：路径穿越（../evil）→ 拒', () => {
  const body = Buffer.from('x');
  const files = [{ path: '../evil.txt', bytes: 1, offset: 0, sha256: sha(body) }];
  const f = craft(headerFor(files), body);
  const v = verifyContainer(f);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /非法路径/);
});

test('unpackBag：篡改容器不落盘；非空目标无 --force 拒绝', async () => {
  const bag = await makeBag('guard');
  const file = path.join(tmp('guardout'), 'bag.whale_mem');
  packBag(bag, file);
  const dest = tmp('guarddest');
  const ok = unpackBag(file, dest);
  assert.equal(ok.ok, true);
  const r = unpackBag(file, dest);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /非空/);
  assert.equal(unpackBag(file, dest, { force: true }).ok, true);

  const buf = fs.readFileSync(file);
  buf[16 + buf.readUInt32LE(12)] ^= 0xff;
  fs.writeFileSync(file, buf);
  const dest2 = path.join(tmp('guarddest2'), 'never');
  const bad = unpackBag(file, dest2);
  assert.equal(bad.ok, false);
  assert.ok(!fs.existsSync(dest2));
});

test('packBag：目标已存在 → 拒；--force 才覆盖；不存在的袋 → 拒', async () => {
  const bag = await makeBag('dup');
  const file = path.join(tmp('dupout'), 'bag.whale_mem');
  assert.equal(packBag(bag, file).ok, true);
  const second = packBag(bag, file);
  assert.equal(second.ok, false);
  assert.match(second.problems.join(), /已存在/);
  assert.equal(packBag(bag, file, { force: true }).ok, true);
  assert.equal(packBag(path.join(tmp('nope'), 'missing'), path.join(tmp('nopeout'), 'x.whale_mem')).ok, false);
});

test('packBag：空袋（manifest.files 为空）→ 拒', () => {
  const dir = tmp('empty');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'whale-bag', version: 0, sections: {}, files: [] }));
  const r = packBag(dir, path.join(tmp('emptyout'), 'x.whale_mem'));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /没有文件/);
});

test('exportBag --single：导出后另出 .whale_mem，且可校验', async () => {
  const data = makeData(tmp('single'));
  const out = tmp('singleout');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, single: true, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.single.ok, true);
  assert.equal(r.single.file, r.dir + '.whale_mem');
  assert.ok(fs.existsSync(r.single.file));
  const v = verifyContainer(r.single.file);
  assert.equal(v.ok, true);
  assert.equal(v.generation, 'gen-abc');
});

test('容器保留 provenance / completeness，解包后仍是合法袋', async () => {
  const data = makeData(tmp('meta'));
  const out = tmp('metaout');
  const r = await exportBag({
    dataDir: data, outRoot: out, yes: true, log: quiet,
    provenance: { platform: 'qq', rescuer: '救渡人', exportedAt: '2026-01-01T00:00:00.000Z' },
    partial: true, missing: ['图片段未导出'],
  });
  assert.equal(r.ok, true);
  const file = path.join(out, 'm.whale_mem');
  assert.equal(packBag(r.dir, file).ok, true);
  const v = verifyContainer(file);
  assert.equal(v.ok, true);
  assert.equal(v.manifest.provenance.platform, 'qq');
  assert.equal(v.manifest.provenance.rescuer, '救渡人');
  assert.equal(v.manifest.completeness, 'partial');
  const dest = path.join(tmp('metadest'), 'd');
  assert.equal(unpackBag(file, dest).ok, true);
  assert.equal(libVerifyBag(dest).ok, true);
});
