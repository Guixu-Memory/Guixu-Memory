// check-imports.mjs —— 袋侧 import 树检查
//
// 规则（归墟独立仓的硬边界）：
//   1. 只允许 node: 内置模块与仓内相对 import；
//   2. 相对 import 必须解析得到，且不得出仓（防 ../ 或绝对路径）；
//   3. 任何 import 说明符不得出现盘符或仓外绝对路径。
//
// 用法：node tools/check-imports.mjs
// 退出码：0 全过；1 有违规。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BANNED = [/[A-Za-z]:[\\/]/];
const RE_IMPORT = /\bimport\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const RE_EXPORT = /\bexport\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g;

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'bags') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
  }
})(ROOT);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const imports = [];
const external = new Set();
const violations = [];
const seen = new Set();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const re of [RE_IMPORT, RE_EXPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      const key = file + ' -> ' + spec;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push({ from: rel(file), spec });

      if (BANNED.some((r) => r.test(spec))) {
        violations.push(`${rel(file)}: 禁止的 import「${spec}」`);
        continue;
      }
      if (spec.startsWith('node:')) {
        external.add(spec);
        continue;
      }
      if (spec.startsWith('.')) {
        const abs = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(abs)) violations.push(`${rel(file)}: 解析不到「${spec}」`);
        const inside = abs === ROOT || abs.startsWith(ROOT + path.sep);
        if (!inside) violations.push(`${rel(file)}: import 出仓「${spec}」`);
        continue;
      }
      // 零依赖：除 node: 外不允许裸包名
      violations.push(`${rel(file)}: 非内置依赖「${spec}」`);
    }
  }
}

const out = {
  root: '<repo>',
  files: files.length,
  imports: imports.length,
  relative: imports.filter((x) => x.spec.startsWith('.')).length,
  builtin: [...external].sort(),
  violations,
  ok: violations.length === 0,
};
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.ok ? 0 : 1;
