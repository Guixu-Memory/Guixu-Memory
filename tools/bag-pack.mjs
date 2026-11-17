// bag-pack.mjs —— 单文件记忆袋（.whale_mem）打包 / 校验 / 解包
//
// 用法：
//   node tools/bag-pack.mjs --in <bagDir> --out <file.whale_mem> [--force]   # 目录袋 → 单文件
//   node tools/bag-pack.mjs --verify <file.whale_mem>                        # 头 + 逐文件 sha256
//   node tools/bag-pack.mjs --unpack <file.whale_mem> --into <dir> [--force] # 单文件 → 目录袋
//
// 容器格式见 lib/bag-container.mjs 头注释；解包结果与导出目录逐字节一致，
// 可直接喂给 tools/bag-import.mjs。
import { packBag, unpackBag, verifyContainer } from '../lib/bag-container.mjs';

const argv = process.argv.slice(2);
const val = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);
const die = (msg, code = 2) => { console.error(msg); process.exitCode = code; };

if (has('verify')) {
  const f = val('verify');
  if (!f) die('用法：--verify <file.whale_mem>');
  else {
    const r = verifyContainer(f);
    console.log(JSON.stringify({ ok: r.ok, problems: r.problems, files: r.files, bytes: r.bytes, generation: r.generation, containerVersion: r.version ?? null, manifestAnchored: r.manifestAnchored === true }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  }
} else if (has('unpack')) {
  const f = val('unpack');
  const dest = val('into');
  if (!f || !dest) die('用法：--unpack <file.whale_mem> --into <dir> [--force]');
  else {
    const r = unpackBag(f, dest, { force: has('force') });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  }
} else {
  const inDir = val('in');
  const out = val('out');
  if (!inDir || !out) die('用法：--in <bagDir> --out <file.whale_mem> [--force]');
  else {
    const r = packBag(inDir, out, { force: has('force') });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  }
}
