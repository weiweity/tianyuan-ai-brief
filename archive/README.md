# 天元 · AI 赋能汇报 Web（已收尾）

> **生命周期：** 已完成 / 参考资产
> **收尾日期：** 2026-07-31
> **当前项目：** [客服 Agent](../business-docs/01-客服Agent项目/README.md)
> **边界：** 本 Web 不再承担项目推进、审批补录或当前状态 SSOT。

历史在线地址固定为 <https://weiweity.github.io/tianyuan-ai-brief/>。当前客服启动会使用独立地址 <https://weiweity.github.io/tianyuan-ai-brief/customer-agent/>。

本归档的 29 个公开文件已按 [`archive-manifest.json`](archive-manifest.json) 冻结。2026-08-03 的目录整理只移动路径，没有改变入口文件或站点目录字节。

---

## 现在如何使用

| 可以 | 不可以 |
|------|--------|
| 参考品牌、版式、信息层级和交互表达 | 把页面状态当作客服 Agent 当前状态 |
| 参考内容分层、离线降级和多视口测试方法 | 继续在这里维护 Owner、预算、门禁或项目决定 |
| 后续新设计需要时复用经过验证的组件思路 | 把本工程直接当作客服 Agent 产品代码底座 |
| 单独形成变更决定后再重新开启维护 | 未经评审直接发布或覆盖线上版本 |

当前项目执行入口：

- [客服 Agent 项目导航](../business-docs/01-客服Agent项目/README.md)
- [项目章程](../business-docs/01-客服Agent项目/00-项目章程.md)
- [总排期与阶段门禁](../business-docs/01-客服Agent项目/01-总排期与阶段门禁.md)
- [G0 责任与证据台账](../business-docs/01-客服Agent项目/02-G0责任与证据台账.md)

---

## 冻结能力快照（v5.25.1）

- 七页汇报壳：立项结果、组合优先级、客服边界、门禁、费用、补录与责任；
- 决策状态隔离与旧草稿拒绝；
- 内容 SHA、可信缓存与离线 Bundle；
- 手机 / 桌面响应式、触控和无障碍检查；
- Mermaid 图表、灯箱、打印和四视口 UI 审计；
- 单元测试、内容契约、构建校验和依赖审计。

这里的客服、供应链、预算和门禁内容是 **2026-07-31 收尾时的汇报快照**。当前正式项目名、日期、范围和状态必须回到业务文档真源。

---

## 归档与发布结构

```text
archive/
├── README.md
├── archive-manifest.json
└── 2026-07-31-ai-project-brief/ # 冻结站点，禁止原地修改
sites/
├── package.json                 # 两个网址的质量与发布工具
├── scripts/                     # Bundle / Pages 编排
└── tests/                       # 单测与 UI 审计
business-docs/01-客服Agent项目/   # 当前客服项目及独立品牌素材
```

| 层级 | 文件 | 历史职责 |
|------|------|----------|
| 壳 | `2026-07-31-ai-project-brief/index.html` | 挂载点与资源声明 |
| 启动 | `2026-07-31-ai-project-brief/js/bootstrap.js` | HTTP 版本化 Bundle 与 file 离线 Bundle |
| 样式 | `2026-07-31-ai-project-brief/css/app.css` | 满屏自适应与移动 / 桌面分层 |
| 冻结内容源 | `2026-07-31-ai-project-brief/data/content.json` | 收尾版本的页面文字、表格与 Mermaid |
| 发布产物 | `2026-07-31-ai-project-brief/data/release.json` 与 Bundle | 冻结生成物 |
| 质量门禁 | `../sites/tests/` 与 `.github/workflows/quality.yml` | 哈希、单测、Schema、UI 与 a11y |

技术细节见冻结文件 [ARCHITECTURE.md](2026-07-31-ai-project-brief/ARCHITECTURE.md)。其中出现的旧目录名属于 7 月 31 日历史记录，不再代表当前仓库结构。

---

## 需要历史预览时

```bash
cd sites
npm ci
npm run serve
# 打开 http://localhost:8765
```

也可双击 `archive/2026-07-31-ai-project-brief/index.html` 查看离线快照。预览只是回看历史资产，不会改变项目状态。

---

## 冻结规则

不要在 `2026-07-31-ai-project-brief/` 原地修改内容。若未来确需修复，必须建立新的日期版本、更新归档清单并单独评审；当前客服项目不得向本目录写状态。

历史 HTML [`../business-docs/99-归档/2026-07-31-立项阶段/print/AI赋能立项_金主一页汇报.html`](../business-docs/99-归档/2026-07-31-立项阶段/print/AI赋能立项_金主一页汇报.html) 只作归档追溯，不是第二份业务正文。

---

## 版本

**v5.25.1 · 2026-07-31 · 已收尾**

项目状态已迁移到 `business-docs/01-客服Agent项目/`；本目录从执行链退出，只保留历史汇报与设计工程参考。
