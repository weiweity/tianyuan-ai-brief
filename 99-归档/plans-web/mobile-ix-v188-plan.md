# 手机端交互与信息架构方案 v1.89（交叉评审修订稿）

> 角色：大厂前端（支付宝/飞书 H5）  
> 产品：HR GM AI 立项 H5 · 7 Tab · content.json SSOT  
> 门槛：**设计 / 工程 / 产品 均 ≥9.5 才开工**  
> 前轮交叉分：Design 9.2 · Eng 8.2 · PM 9.1 → 本稿吸收全部必改补丁

---

## 0. 会中冒烟路径（DoD 第 0 条 · 8–12 分钟）

金主手机演示一次过：

1. **t1 连滑 → t7**（中央带横滑，Tab 过阈即高亮，无错页）  
2. **取舍**展开「各部门」→ 首屏业务卡 = **客服**（非供应链）  
3. **流程图**单击放大 → 点遮罩关闭  
4. **请您勾选**：#1–#4 通栏可点可填；#5–#7 简勾 **2 列**；底栏进度可见  
5. **会后怎么做**：时间线 / 路径表 **2 列卡**；PM callout 通栏  
6. 回弹、连滑、竖读长页 **不误翻页**

---

## 1. 问题 → 根因（勘误）

| # | 诉求 | 根因（以代码为准） |
|---|------|-------------------|
| P1 | Tab 不跟手 | **主因** `pendingGoTimer` 200ms 后才 `go→activate`；Tab 改 class 本身同步。**不是** mermaid 阻塞 |
| P2 | 展开见供应链 | `scrollIntoView(整卡)` 停在 sticky 按钮；`offsetTop` 相对 offsetParent 会算错 |
| P3 | 滑失效 / 全面屏 | 整块 `.detail-card` 等在 skip 里；边缘带与系统抢；轴锁/阈值可优化 |
| P4 | 图放大 | 无 lightbox |
| P5 | 勾选 2 卡 | 全宽单列；富交互不可硬 2 列 |
| P6 | 会后 2 卡 | gate `tr` 单列 + 大量 `!important` 需末段覆盖 |

---

## 2. 原则（收敛版 · V1 只刚需）

1. **过阈跟手**：`touchmove` 过阈帧内 `paintChrome`（非仅 touchend）  
2. **竖滚优先**：先竖则整段手势不翻页  
3. **中央带翻页**：上下各让 **16%**（与 safe-area 取 max）  
4. **表单通栏 / 简信息 2 列**  
5. **展开定位用 getBoundingClientRect**  
6. **V1 不做**：邻 Tab 弱预览、首次 hint、客服 ring 动画（标可砍）

**金主口径（P5 一句话）**  
> 可填可点的 4 行通栏，保证 44px 点得准；简勾 2 列减少滚动——不是偷工，是防表单不可用。

---

## 3. 分项方案（可实现）

### P1 · Tab 跟手

**状态机：** `idle | tracking | dragging-h | committing | bouncing`

| 时机 | 行为 |
|------|------|
| touchmove 首次过阈 | **同 rAF** `paintChrome(nextId)`（tab.active / progress / page-label）；`pendingTabId=next` |
| dx 回落到阈下 | `paintChrome(activeTab)` 回滚 |
| touchend 确认 | `committing`：播 200ms 进位 → `resetStyles` → `activate(next,{fromSwipe})` 幂等 |
| 回弹 / cancel / 硬打断 | 必 `paintChrome(activeTab)` |
| 连滑 | 打断当前动画，以最新 target 重开，**禁止排队** |
| tab.scrollIntoView | `behavior:"auto"`（禁 smooth 拖沓） |

**过阈（稳版）：**  
`dx≥36 || (dx≥24 && dt<240) || |dx|/W≥0.15`

**拆分：** `paintChrome(id)` 同步；`paintPanel` 可含 mermaid。  
**主修点是 onEnd 前的 chrome，不是只拆 activate。**

---

### P2 · 取舍首屏 = 客服

```
展开 → 加 is-dept-open → 双 rAF 等布局
pb = panel-body; first = .dept-card:first-child; sticky = .detail-card-btn
delta = first.getBoundingClientRect().top
      - pb.getBoundingClientRect().top
      - sticky.offsetHeight - 8
pb.scrollTo({ top: pb.scrollTop + delta, behavior: "smooth" })
禁止 card.scrollIntoView
禁止 first.offsetTop 直接减
```

sticky 高度**每帧展开重测**。

---

### P3 · 中央滑页（激进但竖读安全）

**起滑带：**  
`y ∈ [max(0.16H, safe-top+8), H - max(0.16H, safe-bottom+24)]`  
带外不 `tracking`（底缘不作为主翻页承诺）。  
**金主半句：** 翻页认中央带，底缘让给系统返回/手势。

**skip 最终：**  
`a,button,input,textarea,select,label,[contenteditable=true]`  
**移除** `.detail-card .path-row .multi-row .fee-fields .owners-grid .check-status` 区域屏蔽。

**轴锁滞回：**  
- 认横：`|dx|>12 && |dx|>|dy|*1.15`  
- 已锁 h 本手势不改轴（或 `|dy|>|dx|*1.2` 才放弃）  
- **先竖**（`dyFirst>6 && |dy|≥|dx|`）→ 整段不 preventDefault 水平  

**指针 · 贴码契约（二选一，推荐 A，写死进代码）：**  
- **A（推荐）**：保留 `touchstart/move/end/cancel` 主链；`pointerdown/move/up/cancel` **仅** `e.pointerType === "mouse"`（或 `!== "touch"`）。  
- **B**：只绑 Pointer Events，**删除**全部 touch* 监听。  
**禁止**现状 touch + 全量 pointer 双 fire。

**CSS：** `panel-body { touch-action: pan-y }`；认领水平后 stage 临时处理。

**验收：** 长页纯竖滚不翻页；中部横滑可翻；底缘不依赖翻页。

---

### P4 · mermaid 放大

- 单击 host → `#diagram-lightbox`（fixed 遮罩 + clone SVG + 关）  
- `role=dialog aria-modal=true`；关钮 ≥44px；遮罩/Esc；焦点回触发点  
- body 锁 scroll；lightbox 上 stopPropagation 防背后 swipe  
- **不做双指**（V1 只全宽+纵滚）  
- 编辑态 / 正在 is-swiping 不打开  
- tap vs swipe：`movement < 8` 才算 click  

---

### P5 · 请您勾选 2 列

| 行 | 布局 |
|----|------|
| #1 多选 #2 路径 #3 费用 #4 负责人（`.has-path`/rich） | **通栏** `grid-column:1/-1` |
| #5 #6 #7 简勾 | **2 列** |
| later **收起** | `display:none !important`（避免 grid 空槽） |
| later **展开** | 进 grid；卡高 >120px 则该卡通栏 |
| 仅 1 张简勾可见时 | **通栏**（禁半行 orphan） |
| ≤360px | `repeat(auto-fill,minmax(148px,1fr))` 或回单列 |
| 热区 | 整卡可点（tr 委托 → chk-btn），≥44 高 |

**与现网 CSS 硬对账（S4 阻断项，必须写进 PR）：**  
现网 v1.79 起 later 用 `max-height` 折叠，且存在：

```css
/* 反模式：收起仍 display:grid，双列会空槽 */
[data-later-open="false"] tr.chk-tier-later { display: grid !important; }
```

**落地规定：**  
1. **删除或反转**上述规则及依赖「占位折叠」的 later max-height 动画块（#t6 相关）。  
2. 收起态统一为（写在 **mobile CSS 文件末段**，优先级 ≥ 现网）：

```css
#t6 .block[data-type="check-table"][data-later-open="false"] tr.chk-tier-later {
  display: none !important;
  max-height: none !important;
  opacity: 1 !important;
  overflow: visible !important;
}
```

3. 展开后再参与 2 列 grid；与「勿 display:none」旧注释以本方案为准（双列优先于高度动画）。

---

### P6 · 会后怎么做 2 列

- 每个 gate-table **各自** `tbody { display:grid; grid-template-columns:1fr 1fr }`  
- 写在 mobile CSS **末段**，压过现有 `!important`  
- 奇数最后一张自然半行或通栏均可；PM callout 通栏  
- 卡：gate 标题 + html 正文  

---

## 4. 实现切片

| 序 | 切片 | 内容 |
|----|------|------|
| S1 | 手势+Tab | P1+P3 状态机 |
| S2 | 取舍定位 | P2 几何 |
| S3 | Lightbox | P4 |
| S4 | 双列 | P5+P6 CSS+class |

不做库、不改桌面主路径、不改 7 Tab 为长滚。

---

## 5. 风险表

| 风险 | 对策 |
|------|------|
| 斜向竖滚被误吃 | 先竖锁；滞回 1.15 |
| 连滑 Tab/panel 差一页 | 打断动画 + 单 targetId + 回滚 chrome |
| later×grid 空槽 | 收起 display:none |
| ≤360 溢出 | auto-fill / 单列回退 |
| sticky 高度变化 | 动态 getBoundingClientRect |
| Lightbox 背后滚/焦点 | scroll lock + 焦点还原 |
| 乐观 Tab 回弹错 | cancel 必 paintChrome(activeTab) |

---

## 6. 验收清单

- [ ] **会中冒烟**（§0）一次通过  
- [ ] 过阈在 **touchmove 帧** chrome 已满态（非仅 touchend）  
- [ ] 回弹/硬打断 Tab **不**停在错误页  
- [ ] 展开部门 sticky 下首卡 = **客服**  
- [ ] 长页中部纯竖滑不翻页；中部横滑可翻  
- [ ] t2/t6 空白区可水平滑；点 chip/input 不翻页  
- [ ] mermaid 放大/关；编辑态不放大  
- [ ] t6 简勾 2 列；later 折叠无空洞；#1–#4 通栏  
- [ ] t7 两表 2 列；360 宽不横向溢出  
- [ ] 三点菜单、勾选悬浮条、滑页无残留回归 OK  

---

## 7. 交叉评分记录

| 轮次 | Design | Eng | PM | 结论 |
|------|--------|-----|-----|------|
| v1.88 初稿 | 9.2 | 8.2 | 9.1 | FAIL |
| v1.89 补丁稿 | 9.5 PASS | 9.4 FAIL | 9.55 PASS | Eng 差 0.1 |
| v1.89.1 贴码契约 | 9.5 PASS | **9.6 PASS** | 9.55 PASS | **全过 · 已落地 v1.89** |

### paintChrome 契约（Eng 建议，并入）

- 入参 `id`，**只改** tab/dots/progress/page-label DOM  
- **不**写 `activeTab`；commit 才 `go`/`activate`  
- `go(delta)` 原点永远是真实 `activeTab`  

待 Eng ≥9.5 后开工。
