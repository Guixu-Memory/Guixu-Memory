// bag-version.test.mjs —— 版本映射表单测
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_VERSION,
  FORMAT,
  MIGRATIONS,
  BagVersionError,
  assertManifest,
  upgradeBag,
  checkVersion,
} from '../lib/bag-version.mjs';

const bag0 = () => ({
  format: FORMAT,
  version: 0,
  createdAt: '2026-11-08T01:43:46.223Z',
  source: { dataDir: '<DATA>' },
  sections: { memory: { file: 'memory.json', count: 3 } },
});

test('v0 原样通过，notes 为空，to=CURRENT', () => {
  const r = upgradeBag(bag0());
  assert.equal(r.from, 0);
  assert.equal(r.to, CURRENT_VERSION);
  assert.deepEqual(r.notes, []);
  assert.equal(r.bag.sections.memory.count, 3);
});

test('不改入参（深拷贝）', () => {
  const src = bag0();
  const r = upgradeBag(src);
  r.bag.sections.memory.count = 999;
  assert.equal(src.sections.memory.count, 3);
});

test('format 不对 → 抛', () => {
  const b = bag0();
  b.format = 'other';
  assert.throws(() => upgradeBag(b), BagVersionError);
});

test('缺 version / 非整数 / 负数 → 抛', () => {
  for (const v of [undefined, '0', 1.5, -1, null]) {
    const b = bag0();
    b.version = v;
    assert.throws(() => upgradeBag(b), BagVersionError, `version=${String(v)}`);
  }
});

test('缺 sections → 抛', () => {
  const b = bag0();
  delete b.sections;
  assert.throws(() => upgradeBag(b), BagVersionError);
});

test('未知高版本不降级 → 抛', () => {
  const b = bag0();
  b.version = 99;
  assert.throws(() => upgradeBag(b), /高于本程序支持/);
});

test('注入迁移：能链式升级到 v2，且 notes 有两条', () => {
  const migrations = [
    { from: 0, to: 1, apply: (b) => ({ ...b, v1field: true }) },
    { from: 1, to: 2, apply: (b) => ({ ...b, v2field: true }) },
  ];
  const r = upgradeBag(bag0(), 0, { current: 2, migrations });
  assert.equal(r.to, 2);
  assert.equal(r.bag.version, 2);
  assert.equal(r.bag.v1field, true);
  assert.equal(r.bag.v2field, true);
  assert.equal(r.notes.length, 2);
});

test('迁移链断档 → 抛（不猜）', () => {
  const migrations = [{ from: 0, to: 1, apply: (b) => ({ ...b }) }];
  assert.throws(() => upgradeBag(bag0(), 0, { current: 2, migrations }), /缺 v1→v2/);
});

test('迁移返回非对象 → 抛', () => {
  const migrations = [{ from: 0, to: 1, apply: () => null }];
  assert.throws(() => upgradeBag(bag0(), 0, { current: 1, migrations }), /非对象/);
});

test('checkVersion 只读判定：好袋 ok，坏袋给出 why', () => {
  assert.equal(checkVersion(bag0()).ok, true);
  const b = bag0();
  b.version = 99;
  const r = checkVersion(b);
  assert.equal(r.ok, false);
  assert.match(r.why, /高于支持/);
});

test('生产迁移表当前为空（v0 是终点）', () => {
  assert.deepEqual(MIGRATIONS, []);
  assert.equal(CURRENT_VERSION, 0);
});

test('assertManifest 对空值与数组都拒', () => {
  assert.throws(() => assertManifest(null), BagVersionError);
  assert.throws(() => assertManifest([]), BagVersionError);
});
