# Changelog

> 命名三层（2026-11-16 定版）：正式名 **Guixu-Memory**／艺名 **归墟**（README 双名并挂）／`memory-bag` 作为描述关键词。

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
