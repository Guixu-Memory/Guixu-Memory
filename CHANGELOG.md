# Changelog

> 命名三层（2026-11-16 定版）：正式名 **Guixu-Memory**／艺名 **归墟**（README 双名并挂）／`memory-bag` 作为描述关键词。

## 未发布（main）

- **文档：写清摘要锚的"起算点"**。`docs/DESIGN.md` 新增 §7.1——锚只在打成 v2 容器时生效，覆盖打包那一刻的 manifest；目录袋（未打包）阶段 `manifest.json` 仍是免哈希元数据，改 `provenance` / `completeness` / `createdAt` 不检出，打包会把当时的档案（含被改过的）一起锚定。要全程可证＝导出后立刻 `--single` 并记袋哈希。
- `README.md` 安全语义那行补半句「（v2 容器起生效）」，不再给人"从文件出生就防篡改"的印象。
- `docs/KNOWN-ISSUES.md` 记 0.2.2 计划：目录袋阶段把 manifest 纳入完整性保护（候选旁挂 `manifest.sha256` + `verifyBag` 链式核），0.2.2 之前不动代码。
- 测试：+4（`test/bag-manifest.test.mjs`，钉住目录袋态边界与容器态对照），共 **67 例**。
- 已发布物料（0.2.0 / 0.2.1 的 tag、Release、包内 README）一律未动。
- **凭据边界如实标注**：`README.md` 安全语义区明说"当前版本未实现凭据硬拦截"，并点名四类禁存物（API key / token / 私钥 / 数据库 URL）；`docs/KNOWN-ISSUES.md` 把凭据扫描＋硬拦截升格为 **v0.3.0 前必须落地**（最小版 v0.2.2 起做）。原因：凭据一旦写进记忆，导出会原样带走并进 manifest / diff / 备份链——拦得住落地，拦不住被看见。
- **凭据入口闸（v0.2.2 最小版，main 已实现待发）**：导出时逐件扫文本内容＋文件名＋manifest 字段（provenance / missing / source），命中即 **reject**（`--force` 不放行）；只有 `--allow-credentials` 显式开关可过，放行会在 `manifest.credentialOverride` 与 `<outRoot>/audit/export-credentials.jsonl` 留痕。模式集：`sk-`、`AKIA…`、`ghp_/github_pat_`、`BEGIN … PRIVATE KEY`、数据库连接串、URL 内嵌密码、`.env` 文件名。
- 测试：+12（`test/bag-credential.test.mjs`），共 **79 例**。
- **已知边界（凭据闸，二期再议）**：① 大写 `SK-` 开头不触发（真实 key 均为小写 `sk-`）；② 拆进两个 JSON 字段的碎片串不触发（正则本质限制，"拼合扫描"二期再议）；③ base64 私钥长串不触发（已声明二期）。以上均不影响主用例，不返工。

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
