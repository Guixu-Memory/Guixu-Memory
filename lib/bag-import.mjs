// bag-import.mjs —— 记忆袋导入 + 断代
//
// 设计见 docs/DESIGN.md。核心不变量：
//   1. 先写意图（.import-intent.json）再动数据——断电靠它判"半截"；
//   2. 任一段失败 → 全量回滚（不半截，含"删掉导入新增、备份里没有的文件"）；
//   3. 断代只追加，不重写历史；
//   4. 审计写不进 → 中止并回滚（C4 口径）；
//   5. 未知版本/未知段/冻结段 → reject（不猜）。
//
// 边界：不碰护栏、记忆剥离、沉眠钥匙等引擎侧机制。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { upgradeBag, checkVersion } from './bag-version.mjs';

const SECTION_FILES = ['memory.json', 'facts.jsonl', 'longterm.json', 'personas.json'];
const INDEX_FILE = 'memory-index.json';
const FORBIDDEN = ['guardrails', 'sleep-key', 'memory-strip'];
const DEFAULT_BACKUP_ROOT = path.join(process.cwd(), 'pre-import');
const KEEP_ON_ROLLBACK = new Set(['audit/imports.jsonl', 'generation.json', 'audit/register.jsonl']);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p, fb = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; }
};

function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else out.push({ abs, rel });
  }
  return out;
}

function stampUtc(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** 读袋 + 校验容器头 + 逐文件 sha256 + 段计数；不合格返回 problems，不抛。 */
export function verifyBag(bagDir) {
  const problems = [];
  const manifest = readJson(path.join(bagDir, 'manifest.json'));
  if (!manifest) return { ok: false, problems: ['manifest.json 缺失或不是合法 JSON'], manifest: null };

  const v = checkVersion(manifest);
  if (!v.ok) problems.push('版本不可用：' + v.why);

  // 超度三件（均为可选，旧袋没有也照导）
  if (manifest.completeness != null) {
    if (manifest.completeness !== 'full' && manifest.completeness !== 'partial') {
      problems.push('completeness 非法：' + String(manifest.completeness));
    } else if (manifest.completeness === 'partial' && (!Array.isArray(manifest.missing) || manifest.missing.length === 0)) {
      problems.push('completeness=partial 但没写缺失说明（missing）');
    }
  }
  if (manifest.missing != null && !Array.isArray(manifest.missing)) problems.push('missing 不是数组');
  if (manifest.provenance != null) {
    const p = manifest.provenance;
    if (!p || typeof p !== 'object' || Array.isArray(p)) problems.push('provenance 不是对象');
    else {
      if (p.platform != null && typeof p.platform !== 'string') problems.push('provenance.platform 非字符串');
      if (p.rescuer != null && typeof p.rescuer !== 'string') problems.push('provenance.rescuer 非字符串');
      if (p.exportedAt != null && Number.isNaN(Date.parse(p.exportedAt))) problems.push('provenance.exportedAt 不是合法时间');
    }
  }

  for (const f of manifest.files || []) {
    const abs = path.join(bagDir, f.path);
    if (!fs.existsSync(abs)) { problems.push('缺文件 ' + f.path); continue; }
    const buf = fs.readFileSync(abs);
    if (buf.length !== f.bytes) problems.push(`大小不符 ${f.path}（${buf.length}≠${f.bytes}）`);
    else if (sha(buf) !== f.sha256) problems.push(`sha256 不符 ${f.path}`);
  }

  for (const [k, s] of Object.entries(manifest.sections || {})) {
    if (FORBIDDEN.includes(k)) problems.push('袋里含冻结段 ' + k);
    if (k === 'memory' && s.count != null) {
      const arr = readJson(path.join(bagDir, s.file || 'memory.json'), []);
      if (!Array.isArray(arr) || arr.length !== s.count) problems.push('memory 计数不符');
    }
    if (k === 'facts' && s.lines != null) {
      const p = path.join(bagDir, s.file || 'facts.jsonl');
      const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
      if ((t ? t.split('\n').length : 0) !== s.lines) problems.push('facts 行数不符');
    }
  }

  return { ok: problems.length === 0, problems, manifest };
}

/** 只读规划：要导哪些段、多少文件、目标是否可写、是否需要 L3 审批。 */
export function planImport({ bagDir, dataDir, mode = 'restore', force = false, skipSections = [] }) {
  const v = verifyBag(bagDir);
  if (!v.ok) return { ok: false, problems: v.problems, steps: [], needsL3: false };

  const problems = [];
  if (mode !== 'restore') problems.push(`模式 ${mode} 未实现（v1 只有 restore）`);

  const targetEntries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
  const targetEmpty = targetEntries.length === 0;
  if (!targetEmpty && !force) problems.push(`目标非空（${targetEntries.length} 项），restore 拒绝覆盖`);

  const steps = [];
  for (const f of SECTION_FILES) {
    if (!fs.existsSync(path.join(bagDir, f))) continue;
    steps.push({ name: f.replace(/\..*$/, ''), kind: 'file', src: f, dst: f, bytes: fs.statSync(path.join(bagDir, f)).size });
  }
  const jd = path.join(bagDir, 'journal');
  if (fs.existsSync(jd)) {
    const files = walk(jd);
    steps.push({ name: 'journal', kind: 'dir', src: 'journal', dst: 'journal', files: files.length, bytes: files.reduce((a, b) => a + fs.statSync(b.abs).size, 0) });
  }
  const skipped = [];
  const kept = steps.filter((s) => {
    if (skipSections.includes(s.name)) { skipped.push(s.name); return false; }
    return true;
  });
  const hasIndex = fs.existsSync(path.join(bagDir, INDEX_FILE));
  const needsL3 = fs.existsSync(path.join(bagDir, 'personas.json')) && !skipSections.includes('personas');

  return { ok: problems.length === 0, problems, manifest: v.manifest, steps: kept, skipped, needsL3, rebuildIndex: hasIndex, targetEmpty };
}

function copyFileAtomic(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

function snapshot(dataDir, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const f of walk(dataDir)) {
    if (f.rel === '.import-intent.json') continue;
    copyFileAtomic(f.abs, path.join(backupRoot, f.rel));
  }
  return backupRoot;
}

/** 用备份把目标恢复成导入前形状：覆盖回收 + 删除导入新增（保留审计与断代）。 */
function restoreFromSnapshot(backupRoot, dataDir) {
  const kept = new Set(walk(backupRoot).map((f) => f.rel));
  for (const f of walk(backupRoot)) copyFileAtomic(f.abs, path.join(dataDir, f.rel));
  for (const f of walk(dataDir)) {
    if (kept.has(f.rel)) continue;
    if (KEEP_ON_ROLLBACK.has(f.rel)) continue;
    if (f.rel === '.import-intent.json') continue;
    try { fs.unlinkSync(f.abs); } catch {}
  }
}

function appendAudit(dataDir, entry) {
  const dir = path.join(dataDir, 'audit');
  const f = path.join(dir, 'imports.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(f, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeGeneration(dataDir, g) {
  const f = path.join(dataDir, 'generation.json');
  const cur = readJson(f, null);
  const hist = Array.isArray(cur?.history) ? cur.history.slice() : [];
  hist.push(g);
  const tmp = f + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify({ current: g, history: hist }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

/**
 * 执行导入。hooks 仅测试用：{ afterIntent(), afterStep(name), beforeGeneration() } 模拟断电。
 */
export function runImport({
  bagDir, dataDir, mode = 'restore', dryRun = false, force = false, l3Approved = false, skipSections = [],
  hooks = {}, now = () => new Date(), backupRoot = DEFAULT_BACKUP_ROOT, crashAfter = null, approvals = [],
}) {
  const plan = planImport({ bagDir, dataDir, mode, force, skipSections });
  if (dryRun) return { ok: plan.ok, dryRun: true, plan };
  if (!plan.ok) return { ok: false, problems: plan.problems };
  if (plan.needsL3 && !l3Approved) return { ok: false, problems: ['personas 段存在，需 L3 双人批准（l3Approved）'] };
  const approvalRecords = Array.isArray(approvals) && approvals.length ? approvals : (l3Approved ? [{ by: 'owner' }] : []);

  const startedAt = now().toISOString();
  const bagHash = sha(Buffer.from(JSON.stringify(plan.manifest.files || [])));
  const gen = `gen-${stampUtc(now())}-${bagHash.slice(0, 8)}`;
  const intentPath = path.join(dataDir, '.import-intent.json');
  const backupAt = path.join(backupRoot, gen);

  fs.mkdirSync(dataDir, { recursive: true });
  const intent = { gen, bagHash, bagVersion: plan.manifest.version, startedAt, done: [], steps: plan.steps.map((s) => s.name) };
  fs.writeFileSync(intentPath, JSON.stringify(intent, null, 2), 'utf8');
  if (hooks.afterIntent) hooks.afterIntent();

  try {
    snapshot(dataDir, backupAt);
    if (hooks.afterSnapshot) hooks.afterSnapshot();
    const done = [];
    for (const s of plan.steps) {
      if (s.kind === 'file') copyFileAtomic(path.join(bagDir, s.src), path.join(dataDir, s.dst));
      else if (s.kind === 'dir') for (const f of walk(path.join(bagDir, s.src))) copyFileAtomic(f.abs, path.join(dataDir, s.dst, f.rel));
      done.push(s.name);
      fs.writeFileSync(intentPath, JSON.stringify({ ...intent, done }, null, 2), 'utf8');
      if (crashAfter && crashAfter === s.name) process.exit(137); // 演练用：模拟 kill -9
      if (hooks.afterStep) hooks.afterStep(s.name);
    }

    appendAudit(dataDir, {
      at: startedAt, event: 'import', gen, bagHash, bagVersion: plan.manifest.version,
      completeness: plan.manifest.completeness ?? null,
      provenance: plan.manifest.provenance
        ? { platform: plan.manifest.provenance.platform ?? null, rescuer: plan.manifest.provenance.rescuer ?? null, exportedAt: plan.manifest.provenance.exportedAt ?? null }
        : null,
      sections: plan.steps.map((s) => ({ name: s.name, files: s.files ?? 1, bytes: s.bytes })), skipped: plan.skipped || [],
      approvals: approvalRecords,
    });
    if (hooks.beforeGeneration) hooks.beforeGeneration();
    writeGeneration(dataDir, {
      gen, parentGen: null, bagHash, bagVersion: plan.manifest.version,
      createdAt: startedAt, sections: plan.steps.map((s) => s.name), approvals: approvalRecords,
    });
    fs.unlinkSync(intentPath);
    return { ok: true, gen, backupAt, sections: plan.steps.map((s) => s.name) };
  } catch (e) {
    if (e && e.__powerLoss) throw e; // 仅测试用：模拟进程被杀，不清理现场，留给启动恢复
    let rolled = false;
    try {
      if (fs.existsSync(backupAt)) { restoreFromSnapshot(backupAt, dataDir); rolled = true; }
      appendAudit(dataDir, { at: now().toISOString(), event: 'import-failed', gen, error: String(e.message || e), rolledBack: rolled });
    } catch {}
    try { fs.unlinkSync(intentPath); } catch {}
    return { ok: false, problems: ['导入失败' + (rolled ? '并已回滚' : '（回滚未完成！）') + '：' + (e.message || e)], gen };
  }
}

/** 启动时调用：有 intent 且没删 → 视为半截，全量回滚（不续跑）。 */
export function recoverInterrupted({ dataDir, now = () => new Date(), backupRoot = DEFAULT_BACKUP_ROOT }) {
  const intentPath = path.join(dataDir, '.import-intent.json');
  if (!fs.existsSync(intentPath)) return { ok: true, recovered: false };
  let intent = {};
  try { intent = readJson(intentPath, {}) || {}; } catch {}
  const gen = intent.gen || 'unknown';
  const backupAt = path.join(backupRoot, gen);
  let rolledBack = false;
  try {
    if (fs.existsSync(backupAt)) { restoreFromSnapshot(backupAt, dataDir); rolledBack = true; }
    appendAudit(dataDir, { at: now().toISOString(), event: 'import-interrupted', gen, rolledBack, done: intent.done || [] });
  } finally {
    try { fs.unlinkSync(intentPath); } catch {}
  }
  return { ok: true, recovered: true, gen, rolledBack };
}

/** 显式回滚到某代：用该代的导入前快照还原。 */
export function rollbackImport({ dataDir, gen, now = () => new Date(), backupRoot = DEFAULT_BACKUP_ROOT }) {
  const backupAt = path.join(backupRoot, gen);
  if (!fs.existsSync(backupAt)) return { ok: false, problems: [`没有 ${gen} 的导入前快照`] };
  restoreFromSnapshot(backupAt, dataDir);
  appendAudit(dataDir, { at: now().toISOString(), event: 'import-rolled-back', gen });
  return { ok: true, gen };
}

// ---------------- 客舱（--as-guest） ----------------
// 别人（或另一个来源）的袋，导进宿主数据目录下的隔离客舱：<hostDataDir>/guests/<id>/。
// 三条硬线：① 只写客舱目录，绝不写宿主根；② 客舱已存在（非空）不覆盖（D-022 新增优先）；
//          ③ 走与主导入同一套备份/审计/回滚。

const GUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function guestDirOf(hostDataDir, guestId) {
  if (!GUEST_ID.test(String(guestId ?? ''))) return null;
  return path.join(hostDataDir, 'guests', guestId);
}

/** 只读规划：客舱 id 合法性 + 隔离目录 + 袋校验 + 目标非空检查。 */
export function planGuestImport({ bagDir, hostDataDir, guestId, force = false, skipSections = [] }) {
  const guestDir = guestDirOf(hostDataDir, guestId);
  if (!guestDir) return { ok: false, problems: ['guestId 非法：只允许字母/数字/._-，长度 1–64'], steps: [], needsL3: false, guestId: null, guestDir: null };
  const p = planImport({ bagDir, dataDir: guestDir, mode: 'restore', force, skipSections });
  return { ...p, guestId, guestDir, hostDataDir };
}

/** 执行客舱导入；返回带 guestId/guestDir 的结果。 */
export function runGuestImport({
  bagDir, hostDataDir, guestId, dryRun = false, force = false, l3Approved = false,
  skipSections = [], backupRoot = DEFAULT_BACKUP_ROOT, now = () => new Date(), hooks = {}, crashAfter = null, approvals = [],
}) {
  const p = planGuestImport({ bagDir, hostDataDir, guestId, force, skipSections });
  if (dryRun) return { ok: p.ok, dryRun: true, plan: p };
  if (!p.ok) return { ok: false, problems: p.problems };
  if (p.needsL3 && !l3Approved) return { ok: false, problems: ['客舱袋含 personas 段，需 --l3-approved'] };
  const r = runImport({
    bagDir, dataDir: p.guestDir, force, l3Approved, skipSections, backupRoot, now, hooks, crashAfter, approvals,
  });
  return { ...r, guestId: p.guestId, guestDir: p.guestDir };
}
