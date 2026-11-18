# Known issues

## v0.2.0（已发布，按发布冻结不动）

以下问题记录在案，**不在 v0.2.0 上修改**（tag / Release / 线上 README 均保持原样），修复进 0.2.1：

1. **manifest 不自我哈希**：容器只校验 `files` 三元组（path / bytes / sha256）与 payload，manifest 里的 `provenance` / `completeness` / `createdAt` 被改仍可能全链绿。
   → 0.2.1 容器 v2 增加 `manifestSha256` 摘要锚并强制校验。
2. **容器自证、无外部锚**：整包（header + manifest + payload）可被重写出一份内部自洽的新袋；格式只能证明"没搬坏"，不能证明"没被换"。
   → 文档写清边界；防换包靠带外 `SHA256SUMS.txt`（发布件 sha256）。签名（Ed25519）为可选项，尚未实现。
3. **并发承诺与实现不符**：DESIGN 曾写"靠文件锁串行，后者拒绝"，代码并无锁；并发时 `runImport` 会直接覆写 `.import-intent.json`，`recoverInterrupted` 可能把对方现场当半截回滚。
   → 0.2.1 改为意图文件独占创建（`wx`），已存在即拒并提示先 `--recover`；文档改为"不支持并行导入"。

## v0.2.1

- **已知边界（不是事故，文档化行为）**：摘要锚只在**打成 v2 容器时**生效，覆盖"打包那一刻"的 manifest；**目录袋（未打包）阶段 `manifest.json` 仍是免哈希元数据**——改 `provenance` / `completeness` / `createdAt`，`verifyBag` 不检出；把改过的目录袋再打包，假档案会被一起锚进新容器（"洗白"）。
  → 已在 `docs/DESIGN.md` §7.1 写清起算点与"导出后立刻 `--single` 并记袋哈希"的做法；行为由 `test/bag-manifest.test.mjs` 钉住。
- **0.2.2 计划（挪版说明）**：凭据硬拦截——导出时对 `config*` / `register*` 样式的文件直接 reject（当前只有"默认不带人格、密钥不进袋"的约定，无硬拦截）。README 已把承诺改为"导出排除凭据类文件，硬拦截列入 0.2.2"；已发布的 0.2.0/0.2.1 物料一律不碰。
- **0.2.2 计划（完整性补全）**：目录袋阶段把 `manifest.json` 纳入完整性保护（候选：目录袋旁挂 `manifest.sha256`，`verifyBag` 起链式核；打包时把旁挂摘要并入 v2 锚）。**0.2.2 之前不动代码**，先记账；实施后 `test/bag-manifest.test.mjs` 改写为"改 manifest 即红"的正向测试。
