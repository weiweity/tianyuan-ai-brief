# 天元 · AI 赋能汇报 Web（已收尾）

> **生命周期：** 已完成 / 参考资产
> **收尾日期：** 2026-07-31
> **当前项目：** [客服 Agent](../business-docs/01-客服Agent项目/README.md)
> **边界：** 本 Web 不再承担项目推进、审批补录或当前状态 SSOT。

在线地址保留用于历史回看；它可能仍是旧发布，不能作为当前业务口径：[历史在线地址](https://weiweity.github.io/tianyuan-ai-brief/)。

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

## 工程结构

```text
web-decision-brief/
├── package.json          # npm 脚本与依赖
├── docs/                 # 站点与运行时
├── scripts/build-web.mjs # Bundle / release 生成
└── tests/                # 单测与 UI 审计
```

| 层级 | 文件 | 历史职责 |
|------|------|----------|
| 壳 | `docs/index.html` | 挂载点与资源声明 |
| 启动 | `docs/js/bootstrap.js` | HTTP 版本化 Bundle 与 file 离线 Bundle |
| 样式 | `docs/css/app.css` | 满屏自适应与移动 / 桌面分层 |
| UI 编排 | `docs/js/app.js` | 渲染、导航、编辑与写回 |
| 决策域 | `docs/js/modules/decision-model.js` | 汇报期客服执行路径、门禁与凭证 |
| 状态兼容 | `docs/js/modules/meeting-state.js` | 版本隔离、字段白名单与草稿合并 |
| 内容安全 | `docs/js/modules/html-policy.js` | 富文本、资源 URL 与 SVG 清洗 |
| 内容加载 | `docs/js/modules/content-loader.js` | release、SHA、超时与可信缓存 |
| 图表 | `docs/js/modules/mermaid-runtime.js` | Mermaid、字号与灯箱 |
| 冻结内容源 | `docs/data/content.json` | 收尾版本的页面文字、表格与 Mermaid |
| 发布产物 | `docs/data/release.json` 与 Bundle | 由构建脚本生成 |
| 质量门禁 | `tests/` 与 `.github/workflows/quality.yml` | 单测、Schema、UI 与 a11y |

技术细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 需要历史预览时

```bash
npm install
npm run serve
# 打开 http://localhost:8765
```

双击 `docs/index.html` 可查看离线快照。预览只是回看历史资产，不会改变项目状态。

---

## 若未来重新修改

重新启用前先明确：修改目的、Owner、是否重新发布、哪些内容仍属历史。完成修改后至少执行：

```bash
npm run build:check
npm test
npm run test:ui
npm run audit:deps
```

发布仍须走独立评审和发布流程；本次文档重排没有发布、部署或覆盖线上站点。

历史 HTML [`../business-docs/01-立项主线/print/AI赋能立项_金主一页汇报.html`](../business-docs/01-立项主线/print/AI赋能立项_金主一页汇报.html) 只作兼容跳转，不是第二份业务正文。

---

## 版本

**v5.25.1 · 2026-07-31 · 已收尾**

项目状态已迁移到 `business-docs/01-客服Agent项目/`；本目录从执行链退出，转为历史汇报与设计工程参考。
