// credential-scan.mjs —— 导出时的凭据入口闸（v0.2.2 最小版）
//
// 为什么要有这一层（2026-11-18 外部评审点醒）：
//   凭据一旦写进记忆，导出会原样带走，并进 manifest / diff / 备份链——
//   "拦得住落地，拦不住被看见"。完整性（sha256/锚）管的是"没搬坏"，
//   管不了"里面本来就有不该带的东西"，所以入口需要另一层闸。
//
// 范围（刻意做小）：只拦常见凭据模式，不接 vault、不做策略引擎、不猜意图。
//   · 命中即 reject（fail-closed），--force 不放行，只有 --allow-credentials 显式开关可过；
//   · 开关本身要留痕：manifest 里写 credentialOverride，并在 outRoot/audit/export-credentials.jsonl 追加一行。
//
// 扫描面：逐件文本内容 + 文件名 + manifest 字段（provenance / missing / source.dataDir）。
// 性能：O(n) 正则预筛，二进制（含 NUL）跳过内容扫描，超大文件按 maxBytes 跳过（记 note）。
import fs from 'node:fs';

/** 常见凭据模式（起步清单；增补只加规则，不改流程）。 */
export const CREDENTIAL_RULES = [
  { id: 'openai-key', label: 'API key（sk-…）', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: 'aws-akid', label: 'AWS Access Key ID（AKIA…）', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-token', label: 'GitHub token（ghp_/github_pat_…）', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: 'private-key', label: '私钥块（BEGIN … PRIVATE KEY）', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'db-url', label: '数据库连接串（带库类型）', re: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi },
  { id: 'url-basic-auth', label: 'URL 内嵌密码（user:pass@）', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'/@:]+:[^\s"'/@]+@/gi },
];

/** 文件名规则：.env 及其变体 */
const ENV_NAME_RE = /(^|[\\/])\.env(\.[A-Za-z0-9_-]+)?$/i;

/** 脱敏：只留头 4 尾 2，够认、不够用。 */
export function redact(s) {
  const t = String(s ?? '');
  if (t.length <= 8) return t.slice(0, 2) + '***';
  return t.slice(0, 4) + '…' + t.slice(-2);
}

function hitsFrom(text, where) {
  const out = [];
  for (const rule of CREDENTIAL_RULES) {
    // 每次用带 g 的 regex 前置零，避免 lastIndex 残留（跨调用状态泄漏）
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      out.push({ rule: rule.id, label: rule.label, where, sample: redact(m[0]) });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // 防零宽死循环
    }
  }
  return out;
}

/** 扫一段文本（文件名里也会用到）。 */
export function scanText(text, where = '(text)') {
  return hitsFrom(String(text ?? ''), where);
}

/** 扫文件名（.env 与变体）。 */
export function scanFileName(rel) {
  return ENV_NAME_RE.test(rel)
    ? [{ rule: 'env-file', label: '凭据文件名（.env）', where: rel, sample: rel }]
    : [];
}

/**
 * 扫一次导出的全部对象。
 * @param {{files:Array<{abs:string,rel:string,bytes:number}>, provenance?:object|null, missing?:string[], dataDir?:string|null, maxBytes?:number}} o
 * @returns {Array<{rule:string,label:string,where:string,sample:string}>}
 */
export function scanExport({ files = [], provenance = null, missing = [], dataDir = null, maxBytes = 32 * 1024 * 1024 } = {}) {
  const hits = [];
  for (const f of files) {
    hits.push(...scanFileName(f.rel));
    if (f.bytes > maxBytes) continue; // 超大件按预筛跳过（袋资源豁免原则：鲁棒性优先）
    let buf;
    try {
      buf = fs.readFileSync(f.abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // 二进制跳过内容扫描
    hits.push(...scanText(buf.toString('utf8'), f.rel));
  }

  // manifest 字段（导出前由人填的那些）
  const metaStrings = [
    ['provenance.platform', provenance?.platform],
    ['provenance.rescuer', provenance?.rescuer],
    ['provenance.note', provenance?.note],
    ['source.dataDir', dataDir],
  ];
  for (const [where, v] of metaStrings) {
    if (typeof v === 'string' && v) hits.push(...scanText(v, where));
  }
  for (let i = 0; i < (missing?.length ?? 0); i++) {
    if (typeof missing[i] === 'string' && missing[i]) hits.push(...scanText(missing[i], `missing[${i}]`));
  }
  return hits;
}

/** 人话一行一条。 */
export function formatHits(hits) {
  return hits.map((h) => `[${h.rule}] ${h.where}: ${h.sample}（${h.label}）`);
}
