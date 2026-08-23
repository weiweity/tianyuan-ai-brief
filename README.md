# 天元 · AI 赋能项目工作区

**客服架构设计关已于 2026-08-06 以 PASS-WITH-CONDITIONS（静态设计）收口，实现设计关已 Pass · 文档包 Ready；CR-004 与 DEC-042 静态增量已纳入设计包。** 当前推进项是第 3→4 关之间的组织授权门：G0 未签、Ddev 未授权、代码开发未开始。2026-08-10 供应链上海启动会作为独立 P1 并行准备。\
两端 **Ddev 未成立** 前不写产品功能代码。仓储 / 人事只进需求池。

## 项目组合

| 板块 | 当前阶段 | 下一步 |
|------|----------|--------|
| **客服 Agent** | **P0 · 架构 PASS-WITH-CONDITIONS · 实现设计 Pass · Ready** | 组织授权门：Demo / G0 补证 → Ddev 决策；代码未开始 |
| **供应链 · 备案** | **P1 · 会前准备** | **08-10 上海启动会** → 纪要 + 启动结论 |
| 仓储 / 人事等 | 需求池 | 不排期 |
| 设计组 · PSD/AI | 调研反馈（8/07） | 设计负责人过目；非 FDE 立项 |
| 2026-07-31 立项汇报 | 已归档 | 仅历史参考 |

## 快速入口

| 你要做什么 | 入口 |
|------------|------|
| 回看 08-05 阶段决定 | [阶段收口历史快照](business-docs/00-阶段收口_2026-08-05.md) |
| 看项目组合与近窗 | [项目驾驶舱](business-docs/00-项目驾驶舱.md) |
| **08-10 上海启动会** | **[启动会预告](business-docs/02-供应链项目/2026-08-10_上海启动会预告.md)** |
| **看 D0 启动会结论** | **[2026-08-04 D0 纪要](business-docs/01-客服Agent项目/2026-08-04_D0启动会纪要.md)** |
| **客服设计目录（已收口）** | **[客服 Agent 设计阶段](business-docs/01-客服Agent项目/20-设计-进行中/README.md)** |
| 看客服项目全景 | [客服 Agent 项目导航](business-docs/01-客服Agent项目/README.md) |
| 回看需求阶段基线 | [需求阶段归档索引](business-docs/01-客服Agent项目/10-需求-已完成/README.md) |
| 进入供应链板块 | [供应链项目导航](business-docs/02-供应链项目/README.md) |
| **转交设计负责人（PSD/AI）** | **[方案页](business-docs/03-设计组-PSD与AI调研/index.html)** · **[过程说明](business-docs/03-设计组-PSD与AI调研/research-story.html)** · [一页纸](business-docs/03-设计组-PSD与AI调研/00-一页纸_给设计负责人.md) |
| 回看 7 月 31 日汇报 | [归档网址](https://weiweity.github.io/tianyuan-ai-brief/) · [归档说明](archive/README.md) |
| 回看客服启动会快照 | [客服 Agent 会议网址](https://weiweity.github.io/tianyuan-ai-brief/customer-agent/) |
| 查全部文档 | [业务文档地图](business-docs/README.md) |

## 目录原则

```text
ai-赋能立项/
├── business-docs/        # 业务文档；仅逐文件批准且脱敏的公开子集可推送
│   ├── 01-客服Agent项目/  # 客服独立项目与生命周期
│   ├── 02-供应链项目/     # 供应链独立项目入口
│   ├── 03-设计组-PSD与AI调研/  # 调研反馈（非 FDE 立项）
│   └── 99-归档/           # 按时期归档的旧材料
├── local-private/       # 仓内 Git 发布隔离区；不是文件系统物理隔离
├── archive/             # 已冻结的 2026-07-31 汇报 Web
└── sites/               # Pages 发布与质量工具
```

## 五条硬规则

1. 客服与供应链 **不共用** 项目台账、预算、WBS、指标、验收或 Ddev；
2. 技术第 3 关通过不等于开发开工；客服 **Ddev 成立前** 只做合同维护、小实验和组织授权补证；
3. **冲突周先保客服**（约 08-12 demo、08-14 G0），供应链可压缩或顺延；
4. `local-private/` 只有 Git 发布隔离（`.git/info/exclude`），**不是文件系统物理隔离，也不是当前私密项目或真实客户 PII 的长期存放区**；真实姓名、客户内容、内部链接、精确费用与安全细节须用 `prepare_private_customer_project.mjs` 迁到仓外受控目录或公司受控系统。
5. 当前 origin 为 Public 不代表整个 `business-docs/` 默认可发布；本轮客服设计 changeset（整个 `20-设计-进行中/`，含 CR-002/003、training artifacts、OpenAPI/SQL/HTML/SVG）及对应导航、生成视图、generator/tests、依赖锁和支持文件全部服从 `DEC-PUBLISH-01`，未有 exact-file 批准清单时禁止 `git add .`。
