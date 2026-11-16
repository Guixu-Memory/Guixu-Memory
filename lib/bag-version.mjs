// bag-version.mjs —— 记忆袋版本映射表（导入/断代）
//
// 职责：只做「袋的版本 → 当前版本」的纯函数升级，不碰磁盘、不碰审批。
// 规则（见 docs/DESIGN.md）：
//   * manifest.version 必须命中映射表；未知版本一律 reject，**不猜**；
//   * 升级只允许「加字段/改结构」，不允许删内容；
//   * 每次升级产出一条 note，供导入审计落盘（不写正文）。
//
// 用法：
//   const { bag, notes } = upgradeBag(manifestBag, manifestBag.version);
//   // bag 是新对象（不改入参），notes: ['v0→v1: ...']

export const CURRENT_VERSION = 0;
export const FORMAT = 'whale-bag';

/** 迁移表：每条 { from, to, apply(bag) -> bag }。v0 是起点，暂无上迁。 */
export const MIGRATIONS = [];

export class BagVersionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BagVersionError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 校验袋子容器头；不合法直接 throw（调用方按 reject 处理）。 */
export function assertManifest(bag) {
  if (!isPlainObject(bag)) throw new BagVersionError('袋不是一个对象');
  if (bag.format !== FORMAT) throw new BagVersionError(`format 不是 ${FORMAT}：${String(bag.format)}`);
  if (!Number.isInteger(bag.version)) throw new BagVersionError(`version 不是整数：${String(bag.version)}`);
  if (bag.version < 0) throw new BagVersionError(`version 为负：${bag.version}`);
  if (!isPlainObject(bag.sections)) throw new BagVersionError('缺 sections');
  return bag;
}

/**
 * 把袋升级到目标版本。
 * @param {object} bag  袋的 manifest（含 sections）
 * @param {number} [fromVersion] 默认取 bag.version
 * @param {{current?:number, migrations?:Array}} [opts] 仅测试用：注入目标版本/迁移表
 * @returns {{bag:object, notes:string[], from:number, to:number}}
 */
export function upgradeBag(bag, fromVersion = bag?.version, opts = {}) {
  assertManifest(bag);
  const current = Number.isInteger(opts.current) ? opts.current : CURRENT_VERSION;
  const migrations = Array.isArray(opts.migrations) ? opts.migrations : MIGRATIONS;

  let v = fromVersion;
  if (!Number.isInteger(v)) throw new BagVersionError(`fromVersion 不是整数：${String(v)}`);
  if (v > current) throw new BagVersionError(`袋版本 ${v} 高于本程序支持的 ${current}，不降级`);

  let cur = JSON.parse(JSON.stringify(bag)); // 深拷贝，保证入参不被改
  const notes = [];

  while (v < current) {
    const m = migrations.find((x) => x && x.from === v);
    if (!m) throw new BagVersionError(`缺 v${v}→v${v + 1} 的迁移，拒绝猜`);
    const next = m.apply(cur);
    if (!isPlainObject(next)) throw new BagVersionError(`迁移 v${v}→v${m.to} 返回了非对象`);
    cur = next;
    v = m.to;
    notes.push(`v${m.from}→v${m.to}: ok`);
  }

  cur.version = current;
  return { bag: cur, notes, from: fromVersion, to: current };
}

/** 只读判定，不抛：给 CLI 的 --dry-run 用。 */
export function checkVersion(bag) {
  try {
    assertManifest(bag);
    if (bag.version > CURRENT_VERSION) return { ok: false, why: `版本 ${bag.version} 高于支持 ${CURRENT_VERSION}` };
    const missing = [];
    for (let v = bag.version; v < CURRENT_VERSION; v++) {
      if (!MIGRATIONS.some((m) => m && m.from === v)) missing.push(`v${v}→v${v + 1}`);
    }
    if (missing.length) return { ok: false, why: '缺迁移：' + missing.join(',') };
    return { ok: true, version: bag.version, current: CURRENT_VERSION };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}
