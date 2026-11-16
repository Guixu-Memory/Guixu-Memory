# 发布前闸门（内部用，不进发布稿）

> 公开与否是单独一道闸：本文件只列"要公开时"必须先过的检查。

## 1. 硬检查（全 0 才许推）

```powershell
rg "sk-[A-Za-z0-9]{8,}"                       # 真 Key：0
rg "[A-Za-z]:\\\\" README.md docs/ lib/ tools/ test/   # 本机盘符：0
rg "<你的QQ号>|<主机名>" .                      # 主机/账号：0（用真实值在本机跑一次，别写进仓库）
node tools/check-imports.mjs                  # import 树：ok=true
npm test                                      # 全绿
```

## 2. 结构闸

- [ ] LICENSE 已放 Apache-2.0（已放）
- [ ] `package.json` 的 name / version / license 与 LICENSE 一致
- [ ] 示例数据全为虚构；不含任何真实对话、路径、账号
- [ ] `.gitignore` 覆盖 `bags/`、`pre-import/`、`*.whale_mem`、日志
- [ ] 「归墟」商标 1 分钟查询（发布前做一次）
- [ ] 署名邮箱：待主人定（当前 git 用 `guixu-memory@users.noreply.github.com` 占位）

## 3. 公开闸（把上面全过了再谈）

- [ ] 仓库是否公开、何时公开：主人拍板（单独一道闸，不计入本清单的完成度）
- [ ] 仓库设置：关闭 Issues / Discussions / Wiki
- [ ] 发布后不进评论区：不解释、不辩护、不回复
