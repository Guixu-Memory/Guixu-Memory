// bag-export.mjs —— 记忆袋导出 / 校验 / 恢复
//
// 约定：
//   1. personas 默认不导出；要含人格段必须显式 --force；
//   2. 导出前先出计划 + 二次确认（输入 yes 才写盘）；脚本用 --yes 显式跳过，
//      没有交互终端又没 --yes → 直接拒绝；
//   3. manifest 写 generation（取 <dataDir>/generation.json 的 current.gen，没有则 null）。
//
// 用法：
//   node tools/bag-export.mjs --data <dir> [--out <dir>]  # 数据目录必填；输出默认为 ./bags
//   node tools/bag-export.mjs --force                     # 含 personas（危险，显式才给）
//   node tools/bag-export.mjs --platform qq --rescuer 某人 # 记 provenance（何来/平台/救渡人）
//   node tools/bag-export.mjs --partial --missing "缺图"    # 标 partial 并写缺失说明（可多次）
//   node tools/bag-export.mjs --yes                       # 跳过二次确认（脚本用）
//   node tools/bag-export.mjs --dry-run                   # 只出计划，不写盘
//   node tools/bag-export.mjs --single                    # 另打单文件 <袋目录>.whale_mem
//   node tools/bag-export.mjs --allow-credentials         # 显式放行疑似凭据（会在 manifest/audit 留痕；默认命中即拒）
//   node tools/bag-export.mjs --verify <bagDir>           # 逐文件校验 manifest
//   node tools/bag-export.mjs --restore <bagDir> <dest>   # 五来源恢复到隔离目录
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { packBag } from '../lib/bag-container.mjs';
import { scanExport, formatHits } from '../lib/credential-scan.mjs';
import { pathToFileURL } from 'node:url';

const DEFAULT_DATA = null; // 不猜本机路径：--data 必填
const DEFAULT_OUT = path.join(process.cwd(), 'bags');
const SRC = ['memory.json', 'facts.jsonl', 'longterm.json', 'memory-index.json'];
const INDEX_FILE = 'memory-index.json';
const PERSONAS_FILE = 'personas.json';

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJson(p, fb = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } }
function countLines(p) { try { const t = fs.readFileSync(p, 'utf8').trim(); return t ? t.split('\n').length : 0; } catch { return 0; } }

function walkFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walkFiles(p, rel));
    else out.push({ abs: p, rel });
  }
  return out;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 只读规划：要导哪些段、多少文件/字节、personas 是否含、generation 是什么。不写盘。 */
export function planExport({ dataDir = DEFAULT_DATA, includePersonas = false } = {}) {
  if (!dataDir || !fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    return { ok: false, problems: [`数据目录不存在：${dataDir ?? '(未给 --data)'}`], files: [], sections: {}, totalBytes: 0, includePersonas: false, generation: null };
  }

  const problems = [];
  const files = [];
  const sections = {};
  const addFile = (abs, rel) => {
    const bytes = fs.statSync(abs).size;
    files.push({ abs, rel, bytes });
    return bytes;
  };

  for (const f of SRC) {
    const abs = path.join(dataDir, f);
    if (!fs.existsSync(abs)) continue;
    const bytes = addFile(abs, f);
    if (f === 'memory.json') {
      const arr = readJson(abs, []);
      sections.memory = { file: f, bytes, count: Array.isArray(arr) ? arr.length : null };
    } else if (f === 'facts.jsonl') {
      sections.facts = { file: f, bytes, lines: countLines(abs) };
    } else if (f === INDEX_FILE) {
      const j = readJson(abs, {});
      sections.index = { file: f, bytes, model: j.model ?? null, dim: j.dim ?? null, entries: Array.isArray(j.entries) ? j.entries.length : null };
    } else {
      sections[f] = { file: f, bytes };
    }
  }

  let personasIncluded = false;
  const personaAbs = path.join(dataDir, PERSONAS_FILE);
  if (includePersonas && fs.existsSync(personaAbs)) {
    const bytes = addFile(personaAbs, PERSONAS_FILE);
    const j = readJson(personaAbs, {});
    sections.persona = { file: PERSONAS_FILE, bytes, rev: j.rev ?? null, count: j.personas ? Object.keys(j.personas).length : null };
    personasIncluded = true;
  } else if (includePersonas) {
    problems.push(`--force 已给，但 ${PERSONAS_FILE} 不存在`);
  }

  const journalSrc = path.join(dataDir, 'journal');
  if (fs.existsSync(journalSrc)) {
    let lines = 0;
    const jfiles = walkFiles(journalSrc);
    for (const jf of jfiles) {
      addFile(jf.abs, 'journal/' + jf.rel);
      if (jf.rel.endsWith('.jsonl')) lines += countLines(jf.abs);
    }
    if (jfiles.length) sections.journal = { dir: 'journal', files: jfiles.length, lines };
  }

  const cur = readJson(path.join(dataDir, 'generation.json'), null)?.current ?? null;
  const generation = typeof cur === 'string' ? cur : (cur && cur.gen) || null;

  if (!files.length) problems.push('没有可导出的段（memory/facts/longterm/index/journal 全缺）');

  return {
    ok: problems.length === 0,
    problems,
    files,
    sections,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    includePersonas: personasIncluded,
    generation,
  };
}

function writeBag(plan, { outRoot, dataDir, provenance = null, completeness = 'full', missing = [], credentialOverride = null }) {
  const base = path.join(outRoot, 'bag-' + stamp());
  let dir = base;
  for (let i = 1; fs.existsSync(dir); i++) dir = base + '-' + i;
  fs.mkdirSync(dir, { recursive: true });

  const manifestFiles = [];
  for (const f of plan.files) {
    const buf = fs.readFileSync(f.abs);
    fs.mkdirSync(path.dirname(path.join(dir, f.rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.rel), buf);
    manifestFiles.push({ path: f.rel, bytes: buf.length, sha256: sha(buf) });
  }

  // 每段回填 sha256（按段内文件）
  const sections = JSON.parse(JSON.stringify(plan.sections));
  for (const s of Object.values(sections)) {
    const list = manifestFiles.filter((x) => (s.file && x.path === s.file) || (s.dir && x.path.startsWith(s.dir + '/')));
    s.sha256 = sha(list.map((x) => x.path + ':' + x.sha256).sort().join('\n'));
  }

  const meta = {
    format: 'whale-bag',
    version: 0,
    createdAt: new Date().toISOString(),
    generation: plan.generation ?? null,
    ...(provenance ? { provenance } : {}),
    completeness,
    missing,
    source: { dataDir },
    ...(credentialOverride ? { credentialOverride } : {}),
    files: manifestFiles,
    sections,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { dir, manifest: meta };
}

function describePlan(plan, dataDir, log) {
  log(`数据目录：${dataDir}`);
  log(`包含段：${Object.keys(plan.sections).join(', ') || '(无)'}`);
  log(`personas：${plan.includePersonas ? '包含（--force）' : '已排除（默认不导出；要含用 --force）'}`);
  log(`generation：${plan.generation ?? 'null'}`);
  log(`预计：${plan.files.length} 个文件 / ${plan.totalBytes} 字节`);
}

/**
 * 导出。ask 为确认回调（返回字符串，需为 "yes"）；无 ask 且 yes=false → 拒绝。
 * 返回 {ok, dir, manifest, files, bytes} 或 {ok:false, problems} 或 {ok:false, aborted:true}。
 */
export async function exportBag({
  dataDir = DEFAULT_DATA, outRoot = DEFAULT_OUT, includePersonas = false,
  dryRun = false, yes = false, single = false,
  provenance = null, missing = [], partial = false,
  allowCredentials = false,
  ask = null, log = console.log,
} = {}) {
  const plan = planExport({ dataDir, includePersonas });
  describePlan(plan, dataDir, log);

  const missingNotes = [...(Array.isArray(missing) ? missing.filter(Boolean) : [])];
  if (!plan.includePersonas && dataDir && fs.existsSync(path.join(dataDir, PERSONAS_FILE))) {
    missingNotes.push('personas（默认不导出；要含用 --force）');
  }
  const completeness = partial || missingNotes.length ? 'partial' : 'full';
  log(`provenance：${provenance ? `${provenance.platform || '?'} / ${provenance.rescuer || '?'}` : 'null'}`);
  log(`completeness：${completeness}${missingNotes.length ? '（缺：' + missingNotes.join('；') + '）' : ''}`);

  if (!plan.ok) {
    for (const p of plan.problems) log('  ✗ ' + p);
    return { ok: false, problems: plan.problems };
  }

  // 凭据入口闸（v0.2.2 最小版）：文本内容 + 文件名 + manifest 字段，命中即拒（fail-closed）
  const credHits = scanExport({ files: plan.files, provenance, missing: missingNotes, dataDir });
  if (credHits.length) {
    for (const line of formatHits(credHits)) log('  ⚠ ' + line);
    if (!allowCredentials) {
      return {
        ok: false,
        problems: [`检出疑似凭据 ${credHits.length} 处，导出已拒（--force 不放行；确认要导用 --allow-credentials，会在 manifest 与 outRoot/audit 留痕）`],
        credentialHits: credHits,
      };
    }
    log(`凭据闸：${credHits.length} 处命中，--allow-credentials 已显式放行（manifest 与 audit 留痕）`);
  }

  if (dryRun) return { ok: true, dryRun: true, plan, provenance, completeness, missing: missingNotes, credentialHits: credHits };

  if (!yes) {
    if (typeof ask !== 'function') {
      return { ok: false, aborted: true, problems: ['没有交互终端：导出需 --yes，或先用 --dry-run 看计划'] };
    }
    const ans = await ask('确认导出？（输入 yes）：');
    if (String(ans).trim().toLowerCase() !== 'yes') {
      log('已取消，未写盘。');
      return { ok: false, aborted: true };
    }
  }

  const credentialOverride = credHits.length && allowCredentials
    ? { at: new Date().toISOString(), reason: '--allow-credentials', hits: credHits.map((h) => ({ rule: h.rule, where: h.where, sample: h.sample })) }
    : null;

  const { dir, manifest } = writeBag(plan, { outRoot, dataDir, provenance, completeness, missing: missingNotes, credentialOverride });
  if (credentialOverride) {
    // 开关本身进审计：append-only，写在袋目录之外，跟着 outRoot 走
    try {
      const auditDir = path.join(outRoot, 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(path.join(auditDir, 'export-credentials.jsonl'),
        JSON.stringify({ at: credentialOverride.at, bag: dir, reason: credentialOverride.reason, hits: credentialOverride.hits }) + '\n', 'utf8');
    } catch (e) {
      log('  ⚠ 凭据放行审计未写成：' + (e?.message ?? e));
    }
  }
  log('bag ' + dir);
  for (const [k, s] of Object.entries(manifest.sections)) {
    const n = s.count ?? s.lines ?? s.entries ?? s.files ?? '';
    log(`  ${k}: ${n} ${s.file ?? s.dir} sha=${String(s.sha256).slice(0, 16)}`);
  }
  log(`files=${manifest.files.length} manifest=manifest.json`);

  let packed = null;
  if (single) {
    packed = packBag(dir, dir + '.whale_mem');
    if (packed.ok) log(`single ${packed.file} bytes=${packed.bytes} files=${packed.files} sha=${packed.sha256.slice(0, 16)}`);
    else log('单文件打包失败：' + packed.problems.join('; '));
  }
  return { ok: true, dir, manifest, files: manifest.files.length, bytes: manifest.files.reduce((a, b) => a + b.bytes, 0), single: packed, credentialHits: credHits };
}

/** 逐文件 sha256 + 段计数复核；不退出进程，返回 {ok, bad, files, manifest}。 */
export function verifyBag(bagDir) {
  const m = readJson(path.join(bagDir, 'manifest.json'));
  if (!m) return { ok: false, bad: 1, problems: ['manifest.json 缺失或不是合法 JSON'], files: 0, manifest: null };
  let bad = 0;
  const problems = [];
  for (const f of m.files || []) {
    const p = path.join(bagDir, f.path);
    if (!fs.existsSync(p)) { problems.push('MISSING ' + f.path); bad++; continue; }
    const buf = fs.readFileSync(p);
    if (buf.length !== f.bytes || sha(buf) !== f.sha256) { problems.push('MISMATCH ' + f.path); bad++; }
  }
  const mem = readJson(path.join(bagDir, 'memory.json'), []);
  if (m.sections?.memory && Array.isArray(mem) && mem.length !== m.sections.memory.count) { problems.push('memory count mismatch'); bad++; }
  const facts = countLines(path.join(bagDir, 'facts.jsonl'));
  if (m.sections?.facts && facts !== m.sections.facts.lines) { problems.push('facts lines mismatch'); bad++; }
  if (m.sections?.journal) {
    let lines = 0;
    const jd = path.join(bagDir, 'journal');
    if (fs.existsSync(jd)) for (const jf of walkFiles(jd)) if (jf.rel.endsWith('.jsonl')) lines += countLines(jf.abs);
    if (lines !== m.sections.journal.lines) { problems.push('journal lines mismatch'); bad++; }
  }
  return { ok: bad === 0, bad, problems, files: (m.files || []).length, manifest: m };
}

/** 五来源恢复到隔离目录（不含 manifest / 审计）；返回文件数。 */
export function restoreBag(bagDir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of ['memory.json', 'facts.jsonl', 'personas.json', 'longterm.json', 'memory-index.json']) {
    const src = path.join(bagDir, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dest, f)); n++;
  }
  const jd = path.join(bagDir, 'journal');
  if (fs.existsSync(jd)) {
    fs.cpSync(jd, path.join(dest, 'journal'), { recursive: true });
    n += walkFiles(jd).length;
  }
  return { ok: true, files: n };
}

export async function main(argv = process.argv.slice(2)) {
  const val = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const has = (n) => argv.includes('--' + n);

  if (has('verify')) {
    const bagDir = val('verify');
    if (!bagDir) { console.error('用法：--verify <bagDir>'); process.exitCode = 2; return; }
    const r = verifyBag(bagDir);
    for (const p of r.problems) console.error(p);
    console.log((r.ok ? 'OK' : 'FAIL') + ' files=' + r.files + ' bad=' + r.bad
      + ' createdAt=' + (r.manifest?.createdAt ?? '') + ' version=' + (r.manifest?.version ?? ''));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (has('restore')) {
    const bagDir = val('restore');
    const dest = argv[argv.indexOf('--restore') + 2];
    if (!bagDir || !dest) { console.error('用法：--restore <bagDir> <dest>'); process.exitCode = 2; return; }
    const r = restoreBag(bagDir, dest);
    console.log('restored ' + r.files + ' files -> ' + dest);
    return;
  }

  if (!val('data')) {
    console.error('缺少 --data <dir>（记忆袋数据目录）');
    process.exitCode = 2;
    return;
  }
  let ask = null;
  let rl = null;
  if (process.stdin.isTTY && !has('yes')) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  }
  if (!has('yes') && !has('dry-run') && !ask) {
    console.error('非交互环境导出需 --yes（或 --dry-run 先看计划）');
    process.exitCode = 2;
    return;
  }

  const platform = val('platform');
  const rescuer = val('rescuer');
  const note = val('note');
  if ((platform && !rescuer) || (!platform && rescuer)) {
    console.error('--platform 与 --rescuer 要一起给（provenance：何来/救渡人）');
    process.exitCode = 2;
    return;
  }
  const provenance = platform ? { platform, rescuer, exportedAt: new Date().toISOString(), ...(note ? { note } : {}) } : null;
  const missing = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--missing' && argv[i + 1] && !argv[i + 1].startsWith('--')) missing.push(argv[i + 1]);
  }

  try {
    const r = await exportBag({
      dataDir: val('data', DEFAULT_DATA),
      outRoot: val('out', DEFAULT_OUT),
      includePersonas: has('force') || has('include-personas'),
      dryRun: has('dry-run'),
      yes: has('yes'),
      single: has('single'),
      allowCredentials: has('allow-credentials'),
      provenance,
      missing,
      partial: has('partial'),
      ask,
    });
    if (!r.ok) process.exitCode = r.aborted ? 3 : 1;
  } finally {
    if (rl) rl.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  main();
}
