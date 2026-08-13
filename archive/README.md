# 天元 · AI 赋能汇报 Web（已收尾）

> **生命周期：** 已完成 / 参考资产
> **业务收尾日期：** 2026-07-31
> **最近安全维护：** 2026-08-09（不改变业务快照）
> **当前项目：** [客服 Agent](../business-docs/01-客服Agent项目/README.md)
> **边界：** 本 Web 不再承担项目推进、审批补录或当前状态 SSOT。

历史在线地址固定为 <https://weiweity.github.io/tianyuan-ai-brief/>，其根页面发布 2026-08-09 安全维护快照；页面中的业务内容仍是 2026-07-31 收尾快照。当前客服启动会使用独立地址 <https://weiweity.github.io/tianyuan-ai-brief/customer-agent/>。

2026-07-31 原始归档的 29 个文件继续按 [`archive-manifest.json`](archive-manifest.json) 冻结，目录与旧 manifest 均保持字节不动。2026-08-09 安全维护快照按 [`2026-08-09-ai-project-brief-security-maintenance.manifest.json`](2026-08-09-ai-project-brief-security-maintenance.manifest.json) 单独冻结，只升级 DOMPurify / Mermaid 及必要运行产物。

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
├── archive-manifest.json                                      # 7 月 31 日旧收据，字节不动
├── 2026-07-31-ai-project-brief/                               # 原始冻结站点
├── 2026-08-09-ai-project-brief-security-maintenance.manifest.json
└── 2026-08-09-ai-project-brief-security-maintenance/          # 当前公开安全快照
sites/
├── package.json                 # 两个网址的质量与发布工具
├── scripts/                     # Bundle / Pages 编排
└── tests/                       # 单测与 UI 审计
business-docs/01-客服Agent项目/   # 当前客服项目及独立品牌素材
```

| 层级 | 文件 | 历史职责 |
|------|------|----------|
| 原始证据 | `2026-07-31-ai-project-brief/` | 7 月 31 日原始冻结字节，不再直接发布 |
| 当前公开壳 | `2026-08-09-ai-project-brief-security-maintenance/index.html` | 仅安全修补后的挂载点与资源声明 |
| 启动 | `2026-08-09-ai-project-brief-security-maintenance/js/bootstrap.js` | HTTP 版本化 Bundle 与 file 离线 Bundle |
| 样式 | 两份归档的 `css/app.css` | 逐字节相同的满屏自适应与移动 / 桌面分层 |
| 冻结内容源 | 两份归档的 `data/content.json` | SHA-256 相同的 2026-07-31 页面文字、表格与 Mermaid |
| 发布产物 | 安全快照的 `data/release.json` 与 Bundle | 绑定补丁 vendor 的确定性生成物 |
| 质量门禁 | `../sites/tests/` 与 `.github/workflows/quality.yml` | 哈希、单测、Schema、UI 与 a11y |

原始技术细节见冻结文件 [ARCHITECTURE.md](2026-07-31-ai-project-brief/ARCHITECTURE.md)，安全补丁边界见 [SECURITY-MAINTENANCE.md](2026-08-09-ai-project-brief-security-maintenance/SECURITY-MAINTENANCE.md)。安全快照的 `ARCHITECTURE.md` 只同步两项依赖版本，其余历史语义不变。

---

## 需要历史预览时

```bash
cd sites
npm ci
npm run serve
# 打开 http://localhost:8765
```

也可双击 `archive/2026-08-09-ai-project-brief-security-maintenance/index.html` 查看离线安全快照。`2026-07-31-ai-project-brief/` 只用于原始证据回溯。预览不会改变项目状态。

---

## 冻结规则

不要在 `2026-07-31-ai-project-brief/` 或 `2026-08-09-ai-project-brief-security-maintenance/` 原地修改内容。未来若再修复，必须建立新的日期版本、生成独立 manifest 并单独评审；当前客服项目不得向任一归档写状态。

历史 HTML [`../business-docs/99-归档/2026-07-31-立项阶段/print/AI赋能立项_金主一页汇报.html`](../business-docs/99-归档/2026-07-31-立项阶段/print/AI赋能立项_金主一页汇报.html) 只作归档追溯，不是第二份业务正文。

---

## 版本

**业务内容 v5.25.1 · 2026-07-31 已收尾 · 2026-08-09 安全维护**

项目状态已迁移到 `business-docs/01-客服Agent项目/`；本目录从执行链退出，只保留历史汇报与设计工程参考。
