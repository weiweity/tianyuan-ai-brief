# 前端 / 交互打分与 9.5 方案（v1.91）

## 1. 评分总表

| 来源 | 综合 | 交互 IX | 视觉 | 结论 |
|------|------|---------|------|------|
| 对抗交互评审（隐性知识） | **7.9** | **8.0** | 8.3 层次 | FAIL |
| 设计系统评审 | **7.6** | — | **7.5** | FAIL |
| 作者（大厂前端） | **8.1** | **8.2** | 7.8 | 动画不顺是主债 |
| **目标** | **≥9.5** | **≥9.5** | ≥9.0 | 先交 P0–P2 |

Claude CLI 本机 AUTH 不可用（token 环境在但 `claude -p` 未成功），对抗分由独立 plan 子 agent 完成，口径对齐支付宝/微信/飞书/HIG。

---

## 2. 分项（隐性知识视角）

| 维度 | 分 | 要点 |
|------|-----|------|
| 视觉层次 | 8.3 | 卡片流/sticky/悬浮进度有；Tab 热区 30px 偏矮 |
| 动效连贯 | **7.7** | 3 套曲线；JS 180ms 魔法数；拖拽 opacity 鬼影 |
| 手势跟手 | 8.0 | 乐观 Tab 对；缺 velocity、transitionend、连滑 retarget |
| 反馈闭环 | 8.4 | 按压/toast 有；过阈无触感 |
| 隐性知识 | **6.9** | 见下 12 条缺口 |
| 设计 token | 7.5 | 硬编码色/圆角/间距多套 |

---

## 3. 隐性知识缺口（用户难表述，大厂必做）

1. **transitionend 提交**，禁止写死 180ms  
2. **速度阈值**，短距快甩也翻页  
3. **拖拽期禁止正文 opacity 衰减**（实体感）  
4. **进位 duration 跟 velocity**  
5. **prefers-reduced-motion 覆盖 JS 内联 transition**  
6. **过阈 selection 触感**  
7. **连滑 retarget** 而非整段作废  
8. **每 Tab 滚动位置契约**（记忆或置顶二选一）  
9. **Lightbox 缩放锚点 + pan 钳制 + 松手回弹**  
10. **Tab 热区 ≥44px**  
11. **动效单一真相源**（翻页禁用 spring）  
12. **滚动边界二次轴锁**（底/顶可斜滑翻页）

---

## 4. 有序补丁（影响力）

| 序 | 内容 | 预期 IX |
|----|------|---------|
| **P0** | 无 opacity 衰减；velocity 过阈；duration=f(v)；transitionend 提交；过阈 haptic；reduced-motion 瞬切 | 8.0→8.7 |
| **P1** | CSS `--ix-swipe` 唯一；panelIn 降位移；paintChrome 拖拽中不 scrollIntoView | →9.0 |
| **P2** | lightbox pan clamp + scale rubber；Tab 44px | →9.3 |
| **P3** | scroll 契约；detail 展开连续；边界二次轴锁 | →**9.5** |

---

## 5. 本轮已落地（P0–P2 · v1.92）

| 补丁 | 状态 |
|------|------|
| 拖拽无 opacity 鬼影 | ✅ |
| velocity 过阈 (≥0.42 px/ms) | ✅ |
| duration = f(velocity) 140–240ms | ✅ |
| transitionend 提交 + timeout 兜底 | ✅ |
| 过阈 haptic | ✅ |
| reduced-motion 瞬切 | ✅ |
| paintChrome 拖拽不 scrollIntoView | ✅ |
| `--ix-swipe` 单一曲线；panelIn 降位移 | ✅ |
| Tab 热区 44px | ✅ |
| lightbox pan clamp + scale rubber | ✅ |

### 补丁后预估

| 维度 | 预估 |
|------|------|
| 综合 | **9.2–9.4** |
| **交互 IX** | **9.4–9.55** |
| 视觉 | 8.3–8.6（token 全量收敛未做） |

**剩余到稳 9.5（P3）：** 每 Tab 滚动记忆、detail 展开高度连续、边界二次轴锁、状态色/卡片 primitive 收敛。

会中冒烟：连滑无鬼影/无弹帧 · 快甩更短 · 长图双指缩放不飞出 · Tab 更好点。
