// bag-export.test.mjs —— 记忆袋 v0.1 收口：personas 默认排除 / 二次确认 / generation 落 manifest
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportBag, planExport, verifyBag, restoreBag } from '../tools/bag-export.mjs';

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `whale-export-${name}-`));
}

function makeData(dir) {
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify([{ id: 'm1' }, { id: 'm2' }]));
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), '{"id":"f1"}\n{"id":"f2"}\n');
  fs.writeFileSync(path.join(dir, 'longterm.json'), JSON.stringify({ x: 1 }));
  fs.writeFileSync(path.join(dir, 'memory-index.json'), JSON.stringify({ model: 'nomic', dim: 768, entries: [1, 2, 3] }));
  fs.writeFileSync(path.join(dir, 'personas.json'), JSON.stringify({ rev: 45, personas: { a: {}, b: {} } }));
  fs.writeFileSync(path.join(dir, 'journal', '2026-11-01.jsonl'), '{"t":1}\n{"t":2}\n');
  fs.writeFileSync(path.join(dir, 'generation.json'), JSON.stringify({ current: { gen: 'gen-abc' }, history: [] }));
  return dir;
}

const quiet = () => {};

test('planExport：默认排除 personas，段计数与 generation 正确', () => {
  const data = makeData(tmpDir('plan'));
  const p = planExport({ dataDir: data });
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(p.sections).sort(), ['facts', 'index', 'journal', 'longterm.json', 'memory']);
  assert.equal(p.sections.memory.count, 2);
  assert.equal(p.sections.facts.lines, 2);
  assert.equal(p.sections.index.entries, 3);
  assert.equal(p.sections.journal.files, 1);
  assert.equal(p.sections.journal.lines, 2);
  assert.equal(p.includePersonas, false);
  assert.equal(p.generation, 'gen-abc');
  assert.equal(p.files.length, 5);
});

test('exportBag：默认不含 personas.json，manifest 写 generation，可 verify', async () => {
  const data = makeData(tmpDir('default'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, log: quiet });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(r.dir, 'personas.json')));
  assert.equal(r.manifest.sections.persona, undefined);
  assert.equal(r.manifest.generation, 'gen-abc');
  assert.equal(r.manifest.version, 0);
  assert.equal(r.manifest.sections.memory.count, 2);
  assert.equal(r.files, 5);
  const v = verifyBag(r.dir);
  assert.equal(v.ok, true);
  assert.equal(v.bad, 0);
});

test('exportBag：--force（includePersonas）才含人格段，计数与 rev 落 manifest', async () => {
  const data = makeData(tmpDir('personas'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, includePersonas: true, yes: true, log: quiet });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'personas.json')));
  assert.equal(r.manifest.sections.persona.count, 2);
  assert.equal(r.manifest.sections.persona.rev, 45);
  assert.equal(verifyBag(r.dir).ok, true);
});

test('exportBag：--force 但没有人格文件 → 计划不通过', async () => {
  const data = makeData(tmpDir('nopersona'));
  fs.unlinkSync(path.join(data, 'personas.json'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, includePersonas: true, yes: true, log: quiet });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /personas\.json 不存在/);
});

test('exportBag：dry-run 只出计划，不写盘', async () => {
  const data = makeData(tmpDir('dry'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, dryRun: true, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.dir, undefined);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('exportBag：无交互终端且未 --yes → 拒绝，且不写盘', async () => {
  const data = makeData(tmpDir('noask'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, log: quiet });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('exportBag：确认回答不是 yes → 取消', async () => {
  const data = makeData(tmpDir('cancel'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, ask: async () => 'nope', log: quiet });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('exportBag：确认回答 yes → 写盘', async () => {
  const data = makeData(tmpDir('confirm'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, ask: async () => 'yes', log: quiet });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'manifest.json')));
});

test('verifyBag：抓得到字节篡改与段计数篡改', async () => {
  const data = makeData(tmpDir('tamper'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, log: quiet });
  fs.appendFileSync(path.join(r.dir, 'memory.json'), ' ');
  const v = verifyBag(r.dir);
  assert.equal(v.ok, false);
  assert.ok(v.bad >= 1);
});

test('restoreBag：五来源往返，默认不含 personas', async () => {
  const data = makeData(tmpDir('restore'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, log: quiet });
  const dest = tmpDir('dest');
  const rr = restoreBag(r.dir, dest);
  assert.equal(rr.ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'memory.json'), 'utf8'), fs.readFileSync(path.join(data, 'memory.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(dest, 'journal', '2026-11-01.jsonl')));
  assert.ok(!fs.existsSync(path.join(dest, 'personas.json')));
});

test('generation 缺失 → manifest.generation 为 null（旧数据仍可导）', async () => {
  const data = makeData(tmpDir('nogen'));
  fs.unlinkSync(path.join(data, 'generation.json'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.generation, null);
});

test('数据目录不存在 → 计划失败，不写盘', async () => {
  const out = tmpDir('out');
  const p = planExport({ dataDir: path.join(out, 'missing') });
  assert.equal(p.ok, false);
  const r = await exportBag({ dataDir: path.join(out, 'missing'), outRoot: out, yes: true, log: quiet });
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('provenance：--platform/--rescuer/--note 写进 manifest，verify 通过', async () => {
  const data = makeData(tmpDir('prov'));
  const out = tmpDir('out');
  const prov = { platform: 'qq', rescuer: '主人', exportedAt: '2026-01-01T00:00:00.000Z', note: '从旧机器救回来的' };
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, provenance: prov, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.provenance.platform, 'qq');
  assert.equal(r.manifest.provenance.rescuer, '主人');
  assert.equal(r.manifest.provenance.note, '从旧机器救回来的');
  assert.equal(verifyBag(r.dir).ok, true);
});

test('completeness：默认排除 personas → partial + 缺失说明；--force 后 full', async () => {
  const data = makeData(tmpDir('comp'));
  const out = tmpDir('out');
  const r = await exportBag({ dataDir: data, outRoot: out, yes: true, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.completeness, 'partial');
  assert.ok(r.manifest.missing.some((m) => m.includes('personas')));
  assert.equal(verifyBag(r.dir).ok, true);

  const r2 = await exportBag({ dataDir: data, outRoot: out, yes: true, includePersonas: true, log: quiet });
  assert.equal(r2.ok, true);
  assert.equal(r2.manifest.completeness, 'full');
  assert.deepEqual(r2.manifest.missing, []);
  assert.equal(verifyBag(r2.dir).ok, true);
});

test('completeness：--partial + --missing 显式写缺失说明', async () => {
  const data = makeData(tmpDir('comp2'));
  const out = tmpDir('out');
  const r = await exportBag({
    dataDir: data, outRoot: out, yes: true, includePersonas: true,
    partial: true, missing: ['图片/语音段未导出'], log: quiet,
  });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.completeness, 'partial');
  assert.deepEqual(r.manifest.missing, ['图片/语音段未导出']);
  assert.equal(verifyBag(r.dir).ok, true);
});

