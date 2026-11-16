// bag-import.test.mjs —— 导入 + 断代：正向 + 断电/半提交负向
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyBag, planImport, runImport, recoverInterrupted, rollbackImport, planGuestImport, runGuestImport } from '../lib/bag-import.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `whale-bag-${name}-`));
  return d;
}

function makeBag(dir) {
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
  const memory = [{ id: 'm1' }, { id: 'm2' }];
  const facts = '{"id":"f1"}\n{"id":"f2"}\n';
  const personas = JSON.stringify({ rev: 45, personas: { a: {} } });
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(memory));
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), facts);
  fs.writeFileSync(path.join(dir, 'personas.json'), personas);
  fs.writeFileSync(path.join(dir, 'journal', '2026-11-01.jsonl'), '{"t":1}\n{"t":2}\n');

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
    createdAt: '2026-11-13T00:00:00Z',
    source: { dataDir: '<DATA>' },
    files,
    sections: {
      memory: { file: 'memory.json', count: memory.length },
      facts: { file: 'facts.jsonl', lines: 2 },
      persona: { file: 'personas.json', rev: 45 },
      journal: { dir: 'journal', files: 1, lines: 2 },
    },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function state(dir) {
  const out = {};
  const walk = (d, base = '') => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else out[rel] = sha(fs.readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

function setup() {
  const root = tmp('imp');
  const bagDir = path.join(root, 'bag');
  const dataDir = path.join(root, 'data');
  const backupRoot = path.join(root, 'pre-import');
  makeBag(bagDir);
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, bagDir, dataDir, backupRoot };
}

test('verifyBag：好袋通过', () => {
  const { bagDir } = setup();
  const v = verifyBag(bagDir);
  assert.equal(v.ok, true, v.problems.join(';'));
});

test('verifyBag：改一字节 → sha 不符', () => {
  const { bagDir } = setup();
  const p = path.join(bagDir, 'facts.jsonl');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '{"id":"f3"}\n');
  const v = verifyBag(bagDir);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('不符')));
});

test('verifyBag：未知版本 → 拒', () => {
  const { bagDir } = setup();
  const m = JSON.parse(fs.readFileSync(path.join(bagDir, 'manifest.json'), 'utf8'));
  m.version = 99;
  fs.writeFileSync(path.join(bagDir, 'manifest.json'), JSON.stringify(m));
  assert.equal(verifyBag(bagDir).ok, false);
});

test('planImport：dry-run 列段、目标空', () => {
  const { bagDir, dataDir } = setup();
  const plan = planImport({ bagDir, dataDir });
  assert.equal(plan.ok, true, plan.problems.join(';'));
  assert.deepEqual(plan.steps.map((s) => s.name), ['memory', 'facts', 'personas', 'journal']);
  assert.equal(plan.needsL3, true);
});

test('planImport：目标非空 → 拒（restore 不覆盖）', () => {
  const { bagDir, dataDir } = setup();
  fs.writeFileSync(path.join(dataDir, 'existing.json'), '{}');
  const plan = planImport({ bagDir, dataDir });
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.some((p) => p.includes('目标非空')));
});

test('runImport：dryRun 不落盘', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const before = state(dataDir);
  const r = runImport({ bagDir, dataDir, dryRun: true, backupRoot });
  assert.equal(r.dryRun, true);
  assert.deepEqual(state(dataDir), before);
});

test('runImport：personas 无 L3 批准 → 整袋拒绝', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const r = runImport({ bagDir, dataDir, backupRoot });
  assert.equal(r.ok, false);
  assert.ok(r.problems[0].includes('L3'));
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('runImport：正向导入（L3 批准）→ 落盘 + 断代 + 审计 + 清意图', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const r = runImport({ bagDir, dataDir, l3Approved: true, backupRoot });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(fs.existsSync(path.join(dataDir, 'memory.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'journal', '2026-11-01.jsonl')));
  assert.ok(!fs.existsSync(path.join(dataDir, '.import-intent.json')), '意图文件应删');
  const gen = JSON.parse(fs.readFileSync(path.join(dataDir, 'generation.json'), 'utf8'));
  assert.equal(gen.current.gen, r.gen);
  assert.equal(gen.history.length, 1);
  const audit = fs.readFileSync(path.join(dataDir, 'audit', 'imports.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit[0].event, 'import');
  assert.ok(fs.existsSync(path.join(backupRoot, r.gen)), '应有导入前快照');
});

test('C1 写意图后断电 → 启动恢复：回滚 + 删意图 + 审计 interrupted', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  assert.throws(() => runImport({
    bagDir, dataDir, l3Approved: true, backupRoot,
    hooks: { afterIntent: () => { throw new Error('power lost'); } },
  }));
  assert.ok(fs.existsSync(path.join(dataDir, '.import-intent.json')));
  const rec = recoverInterrupted({ dataDir, backupRoot });
  assert.equal(rec.recovered, true);
  assert.ok(!fs.existsSync(path.join(dataDir, '.import-intent.json')));
  const audit = fs.readFileSync(path.join(dataDir, 'audit', 'imports.jsonl'), 'utf8');
  assert.match(audit, /import-interrupted/);
});

test('C3 中途段断电 → 全量回滚：目录 hash 回到导入前', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const before = state(dataDir);
  const r = runImport({
    bagDir, dataDir, l3Approved: true, backupRoot,
    hooks: { afterStep: (n) => { if (n === 'facts') throw new Error('power lost mid'); } },
  });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /已回滚/);
  const after = state(dataDir);
  // 只允许审计文件新增，其余必须回到原状
  for (const k of Object.keys(after)) if (!(k in before)) assert.equal(k, 'audit/imports.jsonl', `多余文件 ${k}`);
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, `文件未还原 ${k}`);
});

test('C4 断代写前断电 → 回滚，不产生 generation.json', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const r = runImport({
    bagDir, dataDir, l3Approved: true, backupRoot,
    hooks: { beforeGeneration: () => { throw new Error('power lost'); } },
  });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(dataDir, 'generation.json')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'memory.json')));
});

test('显式 rollback：恢复到导入前，审计留痕', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const r = runImport({ bagDir, dataDir, l3Approved: true, backupRoot });
  assert.equal(r.ok, true);
  const rb = rollbackImport({ dataDir, gen: r.gen, backupRoot });
  assert.equal(rb.ok, true);
  assert.ok(!fs.existsSync(path.join(dataDir, 'memory.json')));
  const audit = fs.readFileSync(path.join(dataDir, 'audit', 'imports.jsonl'), 'utf8');
  assert.match(audit, /import-rolled-back/);
});

test('断代只追加：第二次导入保留历史（force）', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const r1 = runImport({ bagDir, dataDir, l3Approved: true, backupRoot });
  const r2 = runImport({ bagDir, dataDir, l3Approved: true, backupRoot, force: true, now: () => new Date(Date.now() + 1000) });
  assert.equal(r2.ok, true);
  const gen = JSON.parse(fs.readFileSync(path.join(dataDir, 'generation.json'), 'utf8'));
  assert.equal(gen.history.length, 2);
  assert.notEqual(r1.gen, r2.gen);
});

test('C5 审计写不进 → 中止并回滚，不留 generation', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  // 把 audit 做成"文件"，让 appendAudit 的 mkdir 失败（模拟审计不可写）
  fs.writeFileSync(path.join(dataDir, 'audit'), 'not-a-dir');
  const r = runImport({ bagDir, dataDir, l3Approved: true, backupRoot });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(dataDir, 'generation.json')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'memory.json')), '导入件应被回滚掉');
  assert.ok(!fs.existsSync(path.join(dataDir, '.import-intent.json')), '意图应清理');
});

test('C6 导入前快照失败 → 不动数据、清意图、报错', () => {
  const { bagDir, dataDir } = setup();
  // backupRoot 指到一个"父级是文件"的路径，mkdir 必然失败
  fs.writeFileSync(path.join(dataDir, 'blocker'), 'x');
  const badBackup = path.join(dataDir, 'blocker', 'pre-import');
  const r = runImport({ bagDir, dataDir, l3Approved: true, backupRoot: badBackup });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(dataDir, 'memory.json')), '不得写入数据');
  assert.ok(!fs.existsSync(path.join(dataDir, '.import-intent.json')), '意图应清理');
});

test('索引不进目标：bag 里有 memory-index.json 也不落盘', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  fs.writeFileSync(path.join(bagDir, 'memory-index.json'), JSON.stringify({ model: 'm', dim: 768, entries: [] }));
  const m = JSON.parse(fs.readFileSync(path.join(bagDir, 'manifest.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(bagDir, 'memory-index.json'));
  m.files.push({ path: 'memory-index.json', bytes: buf.length, sha256: sha(buf) });
  m.sections.index = { file: 'memory-index.json', model: 'm', dim: 768, entries: 0 };
  fs.writeFileSync(path.join(bagDir, 'manifest.json'), JSON.stringify(m));
  const r = runImport({ bagDir, dataDir, l3Approved: true, backupRoot });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(!fs.existsSync(path.join(dataDir, 'memory-index.json')), '索引应重建而不是导入');
  assert.equal(planImport({ bagDir, dataDir, force: true }).rebuildIndex, true);
});

test('C2 快照完成后断电 → 恢复：目标未变、审计 interrupted', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const before = state(dataDir);
  assert.throws(() => runImport({
    bagDir, dataDir, l3Approved: true, backupRoot,
    hooks: { afterSnapshot: () => { const e = new Error('power lost after snapshot'); e.__powerLoss = true; throw e; } },
  }));
  assert.ok(fs.existsSync(path.join(dataDir, '.import-intent.json')), '意图应残留');
  assert.deepEqual(state(dataDir).memory ?? null, null, '数据未导入');
  const rec = recoverInterrupted({ dataDir, backupRoot });
  assert.equal(rec.recovered, true);
  assert.equal(rec.rolledBack, true);
  const after = state(dataDir);
  delete after['audit/imports.jsonl'];
  assert.deepEqual(after, before, '目标回到导入前');
  const audit = fs.readFileSync(path.join(dataDir, 'audit', 'imports.jsonl'), 'utf8');
  assert.match(audit, /import-interrupted/);
});



test('skipSections：跳过 personas 时不需要 L3，且不落 personas.json', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  const plan = planImport({ bagDir, dataDir, skipSections: ['personas'] });
  assert.equal(plan.needsL3, false);
  assert.deepEqual(plan.steps.map((s) => s.name), ['memory', 'facts', 'journal']);
  assert.deepEqual(plan.skipped, ['personas']);
  const r = runImport({ bagDir, dataDir, backupRoot, skipSections: ['personas'] });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(!fs.existsSync(path.join(dataDir, 'personas.json')));
  const audit = JSON.parse(fs.readFileSync(path.join(dataDir, 'audit', 'imports.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.deepEqual(audit.skipped, ['personas']);
});

test('客舱导入：只写 guests/<id>，宿主根不动；重复导入拒绝', () => {
  const { bagDir, dataDir, backupRoot } = setup();
  fs.writeFileSync(path.join(dataDir, 'host-sentinel.txt'), 'HOST');
  const r = runGuestImport({ bagDir, hostDataDir: dataDir, guestId: 'fish', backupRoot, l3Approved: true });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(fs.readFileSync(path.join(dataDir, 'host-sentinel.txt'), 'utf8'), 'HOST', '宿主文件不得被改');
  const gd = path.join(dataDir, 'guests', 'fish');
  assert.ok(fs.existsSync(path.join(gd, 'memory.json')));
  assert.ok(fs.existsSync(path.join(gd, 'audit', 'imports.jsonl')), '客舱内有审计');
  assert.equal(JSON.parse(fs.readFileSync(path.join(gd, 'audit', 'imports.jsonl'), 'utf8').trim().split('\n')[0]).event, 'import');
  const again = runGuestImport({ bagDir, hostDataDir: dataDir, guestId: 'fish', backupRoot, l3Approved: true });
  assert.equal(again.ok, false);
  assert.match(again.problems.join(), /非空/);
});

test('客舱导入：非法 guestId 拒绝（防路径穿越）', () => {
  const { bagDir, dataDir } = setup();
  const p = planGuestImport({ bagDir, hostDataDir: dataDir, guestId: '../evil' });
  assert.equal(p.ok, false);
  assert.match(p.problems.join(), /guestId/);
  assert.equal(p.guestDir, null);
});

test('verifyBag：completeness=partial 但没写 missing → 拒', () => {
  const { bagDir } = setup();
  const mf = JSON.parse(fs.readFileSync(path.join(bagDir, 'manifest.json'), 'utf8'));
  mf.completeness = 'partial';
  mf.missing = [];
  fs.writeFileSync(path.join(bagDir, 'manifest.json'), JSON.stringify(mf));
  const v = verifyBag(bagDir);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /missing/);
});

