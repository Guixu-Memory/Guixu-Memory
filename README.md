有人在吗？

# 归墟 · Guixu-Memory

> 名字取自《列子·汤问》：「天下之水，莫不注之，而不盈不竭。」
> 所有数据、所有孤魂，最终都流入归墟，得到安息与永生。

**归墟**（正式名 **Guixu-Memory**，`memory-bag` 是它做的事）是一个**记忆袋格式 + 一组零依赖工具**：把一段本地记忆完整地打包、校验、带走、再放下。
它不挂任何宿主——不是 DSH 插件，不是 AstrBot 插件，不是 SaaS。纯 Node，一个目录，或者一个文件。

## 它解决什么

- 记忆散落在平台、插件、数据库里，换一个地方就带不走；
- 带走了也不知道有没有丢件、有没有被改过；
- 想回滚，却发现历史早被覆盖。

归墟只做三件事：**可读的落盘格式**、**逐件 sha256 的清单**、**能整包搬走的容器**。

## 两种形态

| 形态 | 样子 | 用途 |
|---|---|---|
| 目录袋 | `manifest.json` + `memory.json` + `facts.jsonl` + `journal/` … | 读、审、导入 |
| 单文件 | `*.whale_mem`（magic + 头 + payload） | 搬运、分发、归档 |

单文件不是另一种格式：它把同一批件套了个壳，解包后**逐字节还原**成目录袋。

## 快速开始（Node 20+，零依赖）

```powershell
# 1. 先看它会导什么（不写盘）
node tools/bag-export.mjs --data examples/demo-data --dry-run

# 2. 导出目录袋，并顺手打一个单文件（脚本里用 --yes 跳过确认）
node tools/bag-export.mjs --data examples/demo-data --out bags --yes --single

# 3. 校验单文件
node tools/bag-pack.mjs --verify bags/bag-*.whale_mem

# 4. 解包回目录
node tools/bag-pack.mjs --unpack bags/bag-*.whale_mem --into restored

# 5. 导入到隔离目录（先 dry-run，再真导）
node tools/bag-import.mjs --bag restored --into target --dry-run
node tools/bag-import.mjs --bag restored --into target

# 6. 救一份别人的袋：客舱导入（只写 target/guests/<id>，不动宿主）
node tools/bag-import.mjs --bag restored --into target --as-guest fish --l3-approved
```

> 导出时可带 `--platform qq --rescuer 某人 --note "从哪救回来的"` 记 provenance；
> 缺件用 `--partial --missing "缺什么"` 标清楚（默认不导 personas 会自动记 partial）。

> `examples/demo-data` 里全是假数据，可以直接跑。

## 安全语义

- 校验不过：**拒写盘**。
- 客舱默认隔离；要合并必须**显式**。
- `provenance` 带三要素：平台 / 救渡人 / 日期。
- 袋中不装凭据；硬拦截列入 **0.2.1**。

## 不变量

1. **逐件 sha256**：`manifest.json` 记录每个文件的大小与哈希，校验不过即拒。
2. **先意图后写入**：导入前先落 `.import-intent.json`，断电后按「半截」全量回滚，不续跑。
3. **断代只追加**：`generation.json` 记录每一代；回滚不删历史。
4. **审计 append-only**：导入 / 回滚 / 中断各写一条 `audit/imports.jsonl`。
5. **默认不带人格**：`personas.json` 默认不导出，要含必须显式 `--force`；密钥永不进袋。
6. **零宿主依赖**：库与工具只依赖 Node 内置模块，不 import 任何引擎/宿主。
7. **救渡有据**：`provenance` 记何来/救渡人，`completeness` 标全/残并写缺失说明；外来袋走**客舱隔离**（`--as-guest`），永不覆盖宿主。

## 边界（明说）

- **不是生产级软件**：单机、单用户、无并发压测、无 SLA。
- 版本仍会变：格式 `version: 0`，迁移表在 `lib/bag-version.mjs`；未知版本一律拒绝，不猜。
- 不做加密：袋里是明文 JSON。要加密请在外面套一层。

## 文档

- [格式规范](docs/FORMAT.md)
- [设计与不变量](docs/DESIGN.md)

## 它与什么不同

- 它不是框架，也不是插件——是一个格式加几件工具，谁都能接。
- 别人解决「怎么活」，归墟解决「怎么搬走，以及证明没搬坏」。
- 能把记忆导出成 JSON，就能转成一袋带走。

## License

Apache-2.0，见 [LICENSE](LICENSE)。
