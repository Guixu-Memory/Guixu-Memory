// bag-container.mjs —— 单文件记忆袋容器（.whale_mem，容器版本 1）
//
// 布局（全部小端）：
//   0    8   magic "WHALEBAG"（ASCII）
//   8    2   containerVersion = 1
//   10   2   flags（保留，必须 0）
//   12   4   headerLength（字节）
//   16   ..  header JSON（UTF-8）
//   ..   ..  payload：各文件内容按 header.files 顺序首尾相接
//
// header = {
//   format: 'whale-bag', containerVersion: 1, createdAt: ISO,
//   generation: string|null,
//   manifest: <袋的 manifest.json 原样>,
//   files: [{ path, bytes, offset, sha256 }]   // offset 相对 payload 起点
// }
//
// 不变量：header.files 与 manifest.files 逐项一致（path/bytes/sha256），
// offset 连续且总和 == 文件长 - payload 起点；任一条不满足即拒绝。
// 路径必须是安全相对路径（无 ..、无反斜杠、无盘符、无前导 /）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyBag } from './bag-import.mjs';

const MAGIC = Buffer.from('WHALEBAG', 'ascii');
const FORMAT = 'whale-bag';
const CONTAINER_VERSION = 2;
const LEGACY_VERSIONS = new Set([1]); // v1 无 manifest 摘要锚（0.2.0 产物），只读兼容
const PREFIX = 16;
const MAX_HEADER = 32 * 1024 * 1024;

export const CONTAINER = { MAGIC, FORMAT, VERSION: CONTAINER_VERSION, PREFIX, MAX_HEADER };

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 稳定 JSON（键排序）：manifest 摘要锚的哈希口径。 */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

/** manifest 全文摘要（容器 v2 的锚）。 */
export function manifestDigest(manifest) {
  return sha(Buffer.from(canonicalJson(manifest), 'utf8'));
}

export class ContainerError extends Error {
  constructor(msg) { super(msg); this.name = 'ContainerError'; }
}
const fail = (msg) => { throw new ContainerError(msg); };

function safeRel(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\\') || p.includes(':')) return false;
  if (p.startsWith('/')) return false;
  const n = path.posix.normalize(p);
  if (n !== p) return false;
  if (n === '.' || n === '..' || n.startsWith('../')) return false;
  return true;
}

function readSlice(fd, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, start + done);
    if (n === 0) throw new ContainerError('读到文件尾（容器被截断）');
    done += n;
  }
  return buf;
}

function hashSlice(fd, start, length) {
  const h = crypto.createHash('sha256');
  const CH = 1 << 20;
  const buf = Buffer.allocUnsafe(Math.min(CH, Math.max(1, length)));
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, length - off), start + off);
    if (n === 0) throw new ContainerError('读到文件尾（容器被截断）');
    h.update(buf.subarray(0, n));
    off += n;
  }
  return h.digest('hex');
}

function writeAll(fd, buf) {
  let done = 0;
  while (done < buf.length) {
    const n = fs.writeSync(fd, buf, done, buf.length - done);
    if (n <= 0) throw new ContainerError('写入容器失败');
    done += n;
  }
}

function validateHeader(header, payloadStart, size, version) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) fail('header 不是对象');
  if (header.format !== FORMAT) fail('header.format 不是 ' + FORMAT);
  if (header.containerVersion !== version) fail('header.containerVersion 与文件头不符');
  const m = header.manifest;
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('缺 manifest');
  if (m.format !== FORMAT) fail('manifest.format 不是 ' + FORMAT);
  if (version >= 2) {
    if (typeof header.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(header.manifestSha256)) fail('缺 manifestSha256 锚（v2 必填）');
    if (header.manifestSha256 !== manifestDigest(m)) fail('manifest 摘要锚不符（manifest 被改过）');
  }
  if (!Array.isArray(header.files)) fail('header.files 不是数组');
  if (!Array.isArray(m.files)) fail('manifest.files 不是数组');

  const seen = new Set();
  let offset = 0;
  for (const f of header.files) {
    if (!f || typeof f !== 'object') fail('files 项不是对象');
    if (!safeRel(f.path)) fail('非法路径：' + String(f.path));
    if (seen.has(f.path)) fail('重复路径：' + f.path);
    seen.add(f.path);
    if (!Number.isInteger(f.bytes) || f.bytes < 0) fail('bytes 非法：' + f.path);
    if (f.offset !== offset) fail('offset 不连续：' + f.path);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) fail('sha256 非法：' + f.path);
    offset += f.bytes;
  }
  if (payloadStart + offset !== size) fail(`payload 长度不符（${size - payloadStart}≠${offset}）`);

  const mf = m.files.map((x) => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 }));
  const cf = header.files.map((x) => ({ path: x.path, bytes: x.bytes, sha256: x.sha256 }));
  if (JSON.stringify(mf) !== JSON.stringify(cf)) fail('manifest.files 与容器 files 不一致');
  if ((header.generation ?? null) !== (m.generation ?? null)) fail('header.generation 与 manifest.generation 不一致');
  return { total: offset };
}

/** 打开并校验容器头；成功返回 {fd, header, payloadStart, size}，调用方负责 close。 */
function openHeader(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) fail('不是普通文件：' + file);
  if (st.size < PREFIX) fail('文件太小（< ' + PREFIX + ' 字节）');
  const fd = fs.openSync(file, 'r');
  try {
    const pre = readSlice(fd, 0, PREFIX);
    if (!pre.subarray(0, 8).equals(MAGIC)) fail('magic 不符（不是 .whale_mem）');
    const version = pre.readUInt16LE(8);
    if (version !== CONTAINER_VERSION && !LEGACY_VERSIONS.has(version)) fail(`容器版本 ${version} 不支持（本程序 ${CONTAINER_VERSION}，只读兼容 ${[...LEGACY_VERSIONS].join(',')}）`);
    const flags = pre.readUInt16LE(10);
    if (flags !== 0) fail('flags 必须为 0');
    const headerLen = pre.readUInt32LE(12);
    if (headerLen === 0 || headerLen > MAX_HEADER) fail('header 长度非法：' + headerLen);
    if (PREFIX + headerLen > st.size) fail('header 越过文件尾');
    let header;
    try { header = JSON.parse(readSlice(fd, PREFIX, headerLen).toString('utf8')); } catch { fail('header 不是合法 JSON'); }
    const payloadStart = PREFIX + headerLen;
    validateHeader(header, payloadStart, st.size, version);
    return { fd, header, payloadStart, size: st.size, version };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/** 只读校验：头 + 逐文件 sha256。返回 {ok, problems, files, manifest, generation, bytes}。 */
export function verifyContainer(file) {
  let h;
  try { h = openHeader(file); } catch (e) { return { ok: false, problems: [e.message], files: 0 }; }
  const problems = [];
  try {
    for (const f of h.header.files) {
      let got;
      try { got = hashSlice(h.fd, h.payloadStart + f.offset, f.bytes); } catch (e) { problems.push(e.message); break; }
      if (got !== f.sha256) problems.push('sha256 不符 ' + f.path);
    }
  } finally {
    fs.closeSync(h.fd);
  }
  return {
    ok: problems.length === 0, problems,
    files: h.header.files.length, manifest: h.header.manifest,
    generation: h.header.generation ?? null, bytes: h.size,
    version: h.version, manifestAnchored: h.version >= 2,
  };
}

/** 把目录袋打成单文件；先 verifyBag，再逐件复核，失败不落目标。 */
export function packBag(bagDir, outFile, { force = false } = {}) {
  const v = verifyBag(bagDir);
  if (!v.ok) return { ok: false, problems: v.problems };
  const manifest = JSON.parse(fs.readFileSync(path.join(bagDir, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return { ok: false, problems: ['袋里没有文件'] };
  if (fs.existsSync(outFile) && !force) return { ok: false, problems: ['目标已存在：' + outFile] };

  const files = [];
  const parts = [];
  let offset = 0;
  for (const f of manifest.files) {
    if (!safeRel(f.path)) return { ok: false, problems: ['非法路径：' + f.path] };
    let buf;
    try { buf = fs.readFileSync(path.join(bagDir, f.path)); } catch { return { ok: false, problems: ['读不到 ' + f.path] }; }
    if (buf.length !== f.bytes) return { ok: false, problems: [`大小不符：${f.path}（${buf.length}≠${f.bytes}）`] };
    const h = sha(buf);
    if (h !== f.sha256) return { ok: false, problems: [`sha256 不符：${f.path}`] };
    files.push({ path: f.path, bytes: buf.length, offset, sha256: h });
    parts.push(buf);
    offset += buf.length;
  }

  const header = {
    format: FORMAT,
    containerVersion: CONTAINER_VERSION,
    createdAt: new Date().toISOString(),
    generation: manifest.generation ?? null,
    manifestSha256: manifestDigest(manifest),
    manifest,
    files,
  };
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  if (hb.length > MAX_HEADER) return { ok: false, problems: ['header 过大'] };

  const pre = Buffer.alloc(PREFIX);
  MAGIC.copy(pre, 0);
  pre.writeUInt16LE(CONTAINER_VERSION, 8);
  pre.writeUInt16LE(0, 10);
  pre.writeUInt32LE(hb.length, 12);

  const hash = crypto.createHash('sha256');
  const tmp = outFile + '.tmp-' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const b of [pre, hb, ...parts]) { writeAll(fd, b); hash.update(b); }
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, problems: [String(e.message || e)] };
  }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, outFile); } catch (e) { try { fs.unlinkSync(tmp); } catch {} return { ok: false, problems: [String(e.message || e)] }; }
  return {
    ok: true, file: outFile, bytes: PREFIX + hb.length + offset,
    files: files.length, sha256: hash.digest('hex'), generation: header.generation,
  };
}

/** 解包到隔离目录；先全量校验，再写盘，写完自检为合法袋。目标非空需 force。 */
export function unpackBag(file, destDir, { force = false } = {}) {
  const v = verifyContainer(file);
  if (!v.ok) return { ok: false, problems: v.problems };
  if (fs.existsSync(destDir)) {
    if (!fs.statSync(destDir).isDirectory()) return { ok: false, problems: ['目标不是目录：' + destDir] };
    if (fs.readdirSync(destDir).length && !force) {
      return { ok: false, problems: ['目标目录非空：' + destDir + '（--force 覆盖）'] };
    }
  }
  fs.mkdirSync(destDir, { recursive: true });

  let h;
  try { h = openHeader(file); } catch (e) { return { ok: false, problems: [e.message] }; }
  try {
    for (const f of h.header.files) {
      const buf = readSlice(h.fd, h.payloadStart + f.offset, f.bytes);
      if (sha(buf) !== f.sha256) return { ok: false, problems: ['解包复核失败：' + f.path] };
      const abs = path.join(destDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.tmp-' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, abs);
    }
  } finally {
    fs.closeSync(h.fd);
  }

  // manifest.json 不在 payload 里（不自我哈希），由 header 原样还原
  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(h.header.manifest, null, 2) + '\n', 'utf8');

  const check = verifyBag(destDir);
  if (!check.ok) return { ok: false, problems: ['解包后自检失败：' + check.problems.join('; ')], files: h.header.files.length };
  return { ok: true, files: h.header.files.length, dest: destDir, generation: h.header.generation ?? null };
}
