// bag-import.mjs (CLI) —— 记忆袋导入 / 客舱导入 / 回滚 / 中断恢复
//
// 用法：
//   node tools/bag-import.mjs --bag <bagDir> --into <dataDir> [--dry-run] [--force] [--l3-approved]
//   node tools/bag-import.mjs --bag <bagDir> --into <dataDir> --as-guest <id> [--dry-run]  # 客舱（隔离目录）
//   node tools/bag-import.mjs --recover <dataDir>
//   node tools/bag-import.mjs --rollback <dataDir> --gen <gen>
//
// 约定：
//   * 默认 dry-run 关＝真写；先用 --dry-run 看 plan；
//   * personas 段必须 --l3-approved（L3 双人批准在流程外，CLI 只认这个显式开关）；
//   * 客舱只写 <dataDir>/guests/<id>/，绝不写宿主根；客舱已存在（非空）不覆盖；
//   * 备份目录默认 ./pre-import（--backup-root 可改）。
import path from 'node:path';
import {
  verifyBag, planImport, runImport, recoverInterrupted, rollbackImport,
  planGuestImport, runGuestImport,
} from '../lib/bag-import.mjs';

const argv = process.argv.slice(2);
const val = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const backupRoot = val('backup-root', path.join(process.cwd(), 'pre-import'));

if (has('verify')) {
  const bagDir = val('verify');
  if (!bagDir) { console.error('用法：--verify <bagDir>'); process.exit(2); }
  const v = verifyBag(bagDir);
  console.log(JSON.stringify({
    ok: v.ok, problems: v.problems, files: v.manifest?.files?.length ?? 0,
    version: v.manifest?.version ?? null, completeness: v.manifest?.completeness ?? null,
    provenance: v.manifest?.provenance ?? null,
  }, null, 2));
  process.exit(v.ok ? 0 : 1);
}

if (has('recover')) {
  const dataDir = val('recover');
  if (!dataDir) { console.error('用法：--recover <dataDir>'); process.exit(2); }
  const r = recoverInterrupted({ dataDir, backupRoot });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (has('rollback')) {
  const dataDir = val('rollback');
  const gen = val('gen');
  if (!dataDir || !gen) { console.error('用法：--rollback <dataDir> --gen <gen>'); process.exit(2); }
  const r = rollbackImport({ dataDir, gen, backupRoot });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

const bagDir = val('bag');
const dataDir = val('into');
if (!bagDir || !dataDir) {
  console.error('用法：--bag <bagDir> --into <dataDir> [--dry-run] [--force] [--l3-approved] [--as-guest <id>]');
  process.exit(2);
}

const skipSections = (val('skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const crashAfter = process.env.BAG_IMPORT_CRASH_AFTER || null; // 演练用：到该段后 exit 137 模拟 kill
const approvals = (process.env.BAG_IMPORT_APPROVALS || '').split('|').filter(Boolean).map((s) => { const [by, ref] = s.split('@'); return { by: by || 'owner', ref: ref || '' }; });
const guestId = val('as-guest');

if (guestId) {
  if (has('dry-run')) {
    const p = planGuestImport({ bagDir, hostDataDir: dataDir, guestId, force: has('force'), skipSections });
    console.log(JSON.stringify({
      ok: p.ok, problems: p.problems, guestId: p.guestId, guestDir: p.guestDir,
      needsL3: p.needsL3, steps: p.steps.map((s) => ({ name: s.name, files: s.files ?? 1, bytes: s.bytes })),
    }, null, 2));
    process.exit(p.ok ? 0 : 1);
  }
  const r = runGuestImport({
    bagDir, hostDataDir: dataDir, guestId, force: has('force'), l3Approved: has('l3-approved'),
    skipSections, backupRoot, crashAfter, approvals,
  });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (has('dry-run')) {
  const p = planImport({ bagDir, dataDir, force: has('force'), skipSections });
  console.log(JSON.stringify({
    ok: p.ok, problems: p.problems, needsL3: p.needsL3, rebuildIndex: p.rebuildIndex, skipped: p.skipped,
    steps: p.steps.map((s) => ({ name: s.name, files: s.files ?? 1, bytes: s.bytes })),
  }, null, 2));
  process.exit(p.ok ? 0 : 1);
}

const r = runImport({
  bagDir, dataDir, force: has('force'), l3Approved: has('l3-approved'), skipSections, backupRoot, crashAfter, approvals,
});
console.log(JSON.stringify(r, null, 2));
if (r.ok) {
  console.log('gen=' + r.gen + ' backup=' + r.backupAt);
}
process.exit(r.ok ? 0 : 1);
