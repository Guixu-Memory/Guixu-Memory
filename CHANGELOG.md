# Changelog

> 命名三层（2026-11-16 定版）：正式名 **Guixu-Memory**／艺名 **归墟**（README 双名并挂）／`memory-bag` 作为描述关键词。

## 0.2.1 — 2026-11-17

- **容器 v2：manifest 摘要锚**。header 增加 `manifestSha256`（manifest 键排序稳定 JSON 的 sha256），v2 强制校验——provenance / completeness / createdAt 被改会直接红。v1 只读兼容。
- **并发保护**：`.import-intent.json` 改为独占创建（`wx`）；已存在即拒并提示先 `--recover`。文档同步改成"不支持并行导入"，删掉"靠文件锁串行"的假承诺。
- **自证边界写清**：格式证明"没搬坏"，不证明"没被换"；防换包靠带外 `SHA256SUMS.txt`。
- **v0.2.0 冻结**：tag / Release / 线上 README 不动；0.2.0 的问题记 `docs/KNOWN-ISSUES.md`。
- 测试：+2（v2 摘要锚拒绝 / 并发意图拒绝），共 **63 例**。

## 0.2.0 — 2026-11-16

- **超度三件**：
  - `provenance`：manifest 记何来/平台/救渡人/日期（导出 `--platform --rescuer [--note]`）。
  - `completeness`：`full | partial` + `missing[]` 缺失说明；默认排除 personas 时自动记 partial（`--force` 才 full）。
  - `--as-guest <id>`：客舱导入到 `<dataDir>/guests/<id>/`，只写隔离层、不覆盖宿主；已存在拒绝。
- 导入审计带 `completeness` 与 `provenance` 快照。
- 测试：4 个测试文件，61 例。

## 0.1.0 — 2026-11-16

首个独立仓版本（归墟 · memory-bag）。

- 目录袋格式 v0：`manifest.json` 逐文件 sha256、段计数、`generation` 断代。
- 导入：验袋 → 意图 → 快照 → 逐段原子写 → 审计 → 断代 → 清意图；断电/失败全量回滚。
- 版本映射：未知版本拒绝，不猜。
- 单文件容器 `.whale_mem`（容器 v1）：magic + header + payload，逐件 sha256，路径穿越拒绝。
- 导出默认排除 `personas.json`；导出前二次确认；无 TTY 且无 `--yes` 直接拒绝。
- 工具：`bag-export` / `bag-import` / `bag-pack`，零依赖。
- 测试：4 个测试文件，54 例。
