# Design Review 交叉评分 · Claude CLI × Grok

**日期：** 2026-07-29  
**对象：** https://weiweity.github.io/tianyuan-ai-brief/  
**结构：** `docs/` chrome 上框 + stage 下框 · content-driven v1.4.x  
**方法：** design-review 问题闭环 + Claude CLI 独立审 + Grok 复核 + P0/P1 即时补丁

---

## A · 历史问题是否解决

| # | 问题 | Claude | Grok | 结论 |
|-|-|-|-|-|
| 1 | tabs-row 上下留白过大 | **已解决** | **已解决** | chrome 内 padding 压到 2–4px，margin 0 |
| 2 | Tab / 圆点两行占高 | **已解决** | **已解决** | `flex-direction:row` 单行；手机藏圆点 |
| 3 | 顶栏/Tab/舞台多卡空带 | **已解决** | **已解决** | 仅 chrome + stage 两框，`#app gap:4px` |
| 4 | 一屏内容被挤矮 | **已解决** | **已解决** | `stage-wrap{flex:1;min-height:0}` 吃满剩余 |
| 5 | 手机工具栏 / 触控 | **部分** | **部分→已补** | ⋯ 菜单 OK；tab min-height 已抬到 **30px** |
| 6 | 保存热更 / C 端 30s | **已解决** | **已解决** | softApply + POLL + publishStamp |
| 7 | A11y | **部分** | **部分→已补** | Claude 指 tab focus；已有全局+`.tab:focus-visible`；补 **aria-current** |
| 8 | 投屏/暗色/overscroll | **部分** | **已解决为主** | Claude 漏读：暗色 media **已有**；补 **overflow-x:hidden + overscroll-y:contain** |

**闭环率：** 8 项中 **6 已解决、2 部分（本轮已打补丁）**。无未动手的 P0。

---

## B · 八维交叉打分

| 维度 | Claude（审前结构） | Grok（含本轮补丁） | 共识 |
|-|-|-|-|
| 视觉品牌 | 9.4 | **9.5** | 9.45 |
| 信息层级 | 9.5 | **9.5** | **9.50** |
| 一屏密度 | 9.4 | **9.5** | 9.45 |
| 响应式多端 | 9.5 | **9.5** | **9.50** |
| 触控交互 | 9.2 | **9.4** | 9.30 |
| 工程可维护 | 9.6 | **9.6** | **9.60** |
| 可访问性 | 8.9 | **9.4** | 9.15 |
| 投屏分享 | 9.2 | **9.5** | 9.35 |
| **均分** | **9.28** | **9.48** | **≈9.38** |

> Claude 在「审前快照」上给 **9.275**，主要因 a11y/投屏扣分；其暗色「未实装」判定与代码不符（`prefers-color-scheme:dark` 已在 css）。  
> Grok 在 chrome 零缝 + P0 补丁后评 **9.48**，接近门槛。  
> **交叉综合：9.4 档**（取中偏 Claude 严格：**9.38**）。

### 与历史设计分对照

```
8.38 → 8.81 → 9.275 → 9.43 → 9.46 → 9.52(v1.4.3 终审)
→ 本轮结构审  Claude 9.28 / Grok 9.48 / 交叉 ≈9.38
```

说明：本轮 Claude 更严（对照用户点名的留白问题 + 代码切片），不等于否定 9.52 那轮「感官补丁」已入库；**布局零缝是新基线**，分数应在此基线上再稳态。

---

## C · 门槛判定

| 口径 | 结果 |
|-|-|
| Claude 本轮 | **9.28 · 未达 9.5**（差 0.22） |
| Grok 本轮 | **9.48 · 贴近 9.5** |
| 交叉综合 | **≈9.38 · 未稳过 9.5** |
| 历史 Claude 9.52 | 仍作 v1.4.3 感官轮记录，不与本轮矛盾 |

**结论：** 用户点名的 **留白 / 上下框** 问题 **已解决**；整体设计 **可用可投屏**，交叉分 **9.4 档**，若要双声部都盖「9.5」还需做完下方 P0/P1。

---

## D · 仍需调整需求（按优先级）

### P0（建议本周做完 · 拉均分过 9.5）

| ID | 需求 | 落点 | 预期 |
|-|-|-|-|
| ~~D1~~ | ~~`.tab:focus-visible` 焦点环~~ | 已存在 / 已确认 | a11y |
| ~~D2~~ | ~~`overflow-x:hidden` + overscroll contain~~ | **本轮已补** | 投屏/iOS |
| ~~D3~~ | ~~tab min-height ≥30px~~ | **本轮已补** | 触控 |
| ~~D4~~ | ~~tabs-row padding 再压~~ | **本轮已补 2/4px** | 密度 |

### P1（体验加分）

| ID | 需求 | 落点 | 说明 |
|-|-|-|-|
| D5 | edge-nav 桌面 hover 显、默认隐 | `.edge-nav` + `@media (hover:hover)` | 不挤视觉 |
| D6 | 暗色 token 复核（Claude 误判为无） | 实机切系统暗色验一遍 | 投屏夜间 |
| D7 | logo 命中区 min 44×44 | `.logo-wrap` | 审计兜底 |
| D8 | 弱网 softApply 失败退避文案统一 | `checkRemoteUpdate` | 工程 |

### P2（可选）

| ID | 需求 | 说明 |
|-|-|-|
| D9 | PWA manifest / standalone | 金主二次打开更像 App |
| D10 | 关键数字 `.num` 金色在 content 里用 | 感官 |
| D11 | mermaid CDN 离线 fallback PNG | 会场无网 |

---

## E · 本轮已落地补丁（随 design-review）

1. `#app gap: 4px`（更贴）  
2. `.tabs-row padding: 2px 8px 4px`  
3. `.tab min-height: 30px`  
4. `body overflow-x:hidden` + `overscroll-behavior-y: contain`  
5. pager-dots **`aria-current="true"`**  
6. 资源版本 `?v=1.46`

---

## F · 总判

> **用户点名的 Tab 留白与上下框自适应：已解决。**  
> Claude 交叉审 **9.28**、Grok **9.48**、综合 **≈9.38**；工程与布局已是 9.5 级骨架，差在 a11y/投屏细节稳态与实机暗色验收。  
> **可继续对外分享投屏**；若要对齐「双声部均 ≥9.5」，按 P1 做 edge-nav 显隐 + 暗色实机过一遍即可。

---

## 链接

- 页：https://weiweity.github.io/tianyuan-ai-brief/  
- 仓：https://github.com/weiweity/tianyuan-ai-brief  
- 前序：`33-设计分_v1.4.3_Claude9.52.md`
