# 格式规范（v0 / 容器 v1）

> 状态：v0.1，稳定但仍在演进。任何不兼容改动都会升 `version` 并提供迁移表。

## 1. 目录袋

```
bag-YYYYMMDD-HHmmss/
  manifest.json           # 容器头：format / version / createdAt / generation / files / sections
  memory.json             # 记忆条目数组
  facts.jsonl             # 事实（每行一条 JSON）
  longterm.json           # 长期记忆
  personas.json           # 人格注册表（默认不导出；导出需 --force）
  memory-index.json       # 向量索引（派生物，可在目标机重建）
  journal/                # 按天 / 分层的 JSONL
    YYYY-MM-DD.jsonl
    meaningful/…
    mundane/…
```

- 选袋只看 `manifest.createdAt` 或目录名，**不看文件 mtime**。
- `memory-index.json` 是派生物；删了能重算，坏了不影响事实层。

## 2. manifest.json

```json
{
  "format": "whale-bag",
  "version": 0,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "generation": "gen-20260101T000000Z-abcdef12",
  "source": { "dataDir": "<导出时的数据目录>" },
  "files": [
    { "path": "memory.json", "bytes": 1234, "sha256": "…" }
  ],
  "sections": {
    "memory": { "file": "memory.json", "bytes": 1234, "count": 2, "sha256": "…" },
    "facts": { "file": "facts.jsonl", "bytes": 100, "lines": 2, "sha256": "…" },
    "persona": { "file": "personas.json", "bytes": 80, "rev": 45, "count": 2, "sha256": "…" },
    "journal": { "dir": "journal", "files": 1, "lines": 2, "sha256": "…" }
  }
}
```

- `files[]` 是**逐文件**的大小与 sha256；`sections` 是**按段**的计数与聚合哈希。
- `generation` 为导入断代 id；没有断代链时是 `null`（旧袋仍可导）。
- `provenance`（可选）：`{ platform, rescuer, exportedAt, note? }`——这袋**何来/平台/救渡人/日期**。
- `completeness`：`full` 或 `partial`；**`partial` 必须在 `missing[]` 写清缺了什么**（导出的默认值会把"personas 未导出"记进去）。
- 冻结段（护栏、记忆剥离、沉眠钥匙）**不得**出现在袋里；校验会拒。

## 3. 版本

- `manifest.version` 必须是整数且命中迁移表（`lib/bag-version.mjs`）。
- 未知版本、高于程序支持的版本：**拒绝，不猜**。
- 升级只允许加字段/改结构，不允许删内容；每次升级产出一条 note，写进导入审计。

## 4. 单文件容器 `.whale_mem`（容器 v1）

全部小端：

```
0    8   magic "WHALEBAG"（ASCII）
8    2   containerVersion = 1
10   2   flags = 0（保留）
12   4   headerLength（字节）
16   ..  header JSON（UTF-8）
..   ..  payload：各文件内容按 header.files 顺序首尾相接
```

`header`：

```json
{
  "format": "whale-bag",
  "containerVersion": 1,
  "createdAt": "…",
  "generation": "…",
  "manifest": { /* 目录袋的 manifest.json 原样 */ },
  "files": [
    { "path": "memory.json", "bytes": 1234, "offset": 0, "sha256": "…" }
  ]
}
```

校验顺序（任一条不过即拒）：

1. magic / 版本 / flags / header 长度合法；
2. `header.files` 与 `manifest.files` 逐项一致（path / bytes / sha256），顺序相同；
3. `offset` 首尾相接，总和等于 payload 长度；
4. 逐文件重算 sha256。

路径只接受安全相对路径：不含 `..`、反斜杠、盘符、前导 `/`。解包拒绝写非空目录（`--force` 才覆盖），且先全量校验再落盘。

`manifest.json` 自身不进 payload（不自我哈希），解包时从 header 原样还原。

## 5. CLI 对照

| 命令 | 作用 |
|---|---|
| `node tools/bag-export.mjs --data <dir> [--out <dir>]` | 目录袋导出（交互确认；`--yes` 跳过） |
| `--force` | 含 personas（默认排除） |
| `--single` | 另打 `<袋目录>.whale_mem` |
| `--dry-run` | 只出计划 |
| `--verify <bagDir>` | 逐文件校验 |
| `--restore <bagDir> <dest>` | 恢复到隔离目录 |
| `node tools/bag-pack.mjs --in <bagDir> --out <file>` | 目录袋 → 单文件 |
| `--verify <file>` / `--unpack <file> --into <dir>` | 校验 / 解包 |
| `node tools/bag-import.mjs --bag <bagDir> --into <dataDir>` | 导入（`--dry-run` 先预演） |
| `node tools/bag-import.mjs --bag <bagDir> --into <dataDir> --as-guest <id>` | 客舱导入（隔离目录，不动宿主） |
