# 设计与不变量

> 这份文档解释「为什么导入写得这么啰嗦」。代码在 `lib/bag-import.mjs`。

## 1. 导入是一次可回滚的事务

一次导入要动多个文件（memory / journal / facts / longterm / personas）。任何一步失败，都必须回到导入前，**不接受半截**。

流程：

1. **验袋**：manifest 逐文件 sha256 + 段计数。不合格直接拒。
2. **目标检查**：`restore` 要求目标为空；非空拒绝（防误覆盖）。
3. **写意图**：`<dataDir>/.import-intent.json`，记下 gen / bagHash / 段清单 / 起始时刻。
   这一步**先落盘**——断电后靠它识别「半截」。
4. **备份目标**：整目录快照到 `pre-import/<gen>/`。
5. **逐段导入**：每段写临时文件 → 校验 → 原子 rename；每完成一段更新 `done[]`。
6. **写审计**：`audit/imports.jsonl` 追加一条（append-only，fsync）。
7. **写断代**：`generation.json` 追加 `{gen, bagHash, bagVersion, sections, approvals, createdAt}`。
8. **清意图**：删 `.import-intent.json`（最后一步）。

## 2. 断电与回滚

| 触发 | 动作 |
|---|---|
| 任一段失败（磁盘满 / 权限 / 校验不过） | 全量回滚：用 `pre-import/<gen>` 还原 → 审计 `import-failed` → 删意图 |
| 断电（启动时发现意图且 `done[]` 不全） | 全量回滚，审计 `import-interrupted`；**不续跑**（续跑风险高于重来） |
| 用户显式 `--rollback <gen>` | 还原该代快照 → 审计 `import-rolled-back`；不删断代历史 |
| 审计写不进 | 中止并回滚 |

回滚会**删除导入新增、而备份里没有的文件**；审计与断代文件例外保留。

## 3. 幂等与并发

- 同一 `bagHash` 重复导入：跳过（`--force` 才重导）。
- 并发保护：`.import-intent.json` **独占创建**（`open(..., 'wx')`）；已存在即拒，提示先 `--recover`。
  **不支持并行导入**——同一目标目录请串行；崩溃留下的意图文件本身就是"先 recover"的信号。

## 4. 人格段的闸

- `personas.json` 是**人格数据**，默认不导出；导出必须显式 `--force`。
- 导入含 personas 的袋，需要 `--l3-approved`（双人批准在流程外，CLI 只认显式开关）。
- 没有批准 → 整袋拒绝，不导一半。

## 5. 超度三件（2026-11-16）

救一份别人的记忆，光有文件不够：要知道**它从哪来**、**有没有缺件**、**放哪里才不伤到收留者**。

1. **`provenance`**：manifest 里记 `{ platform, rescuer, exportedAt, note? }`——何来、平台、救渡人、日期。
2. **`completeness`**：`full | partial`；`partial` 必须带 `missing[]` 说明缺了什么（默认导出会把"personas 未导出"记进去）。
3. **客舱 `--as-guest <id>`**：把外来袋导进 `<宿主数据目录>/guests/<id>/`，只写这一层、**绝不写宿主根**；客舱已存在不覆盖（D-022 新增优先）；走的还是同一套备份/审计/回滚。

## 6. 边界

- 不碰引擎侧：护栏、记忆剥离、沉眠钥匙。
- 不做加密、不做压缩、不内置网络。
- 袋里的数据是明文 JSON；要保密请在外部加密。

## 7. 自证到哪、不到哪（容器 v2）

- **能证**：袋没被搬坏——逐件 sha256 + manifest 摘要锚（v2）+ payload 长度闭合；任何一位改动都会红。
- **不能证**：袋没被**换过**——整个容器（含 header/manifest）可以被重写出一份内部完全自洽的新袋。
- 所以防换包靠**带外锚**：发布时给 `SHA256SUMS.txt`（zip/容器的 sha256），从可信渠道取；签名（Ed25519）是 0.2.1 的可选项，尚未实现。
