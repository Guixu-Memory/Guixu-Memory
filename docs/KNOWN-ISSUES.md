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

- 已知：无。
