# Plan: 客服 Agent 一期技术栈落地（Route A · 包甲 → S2）

**Status:** **SUPERSEDED by 37 + 39** · 2026-08-06（历史包甲计划；**禁止**当作生产 SoR 选型）\
**架构北极星：** [`37-架构SSOT-v1.md`](../../20-设计-进行中/37-架构SSOT-v1.md)\
**API：** [`39-API合同与发布状态机-v1.md`](../../20-设计-进行中/39-API合同与发布状态机-v1.md)\
**SoR：** PostgreSQL（[`33`](../../20-设计-进行中/33-schema-v1-草案.sql)）\
**本文保留价值：** Demo 工程切片、测试清单、IPC 安全意识 — **仅 Demo profile 附页**\

## One-liner（生产拓扑 · 以 37 为准）

**Electron 壳 + 中心 TS API + PostgreSQL SoR + Import→Publish→Announce**；本地 SQLite 仅可选只读缓存；剪贴板主路径；DeepSeek/向量/真自动填后置。

## Architecture (production · 37)

```
Electron client (float + dashboard)
  └─ HTTPS → Application API (TS/Node) ports: auth|search|events|metrics|content|announce|policy|redaction
        └─ PostgreSQL SoR (33) · optional object store for import files
  optional: local SQLite read-only release snapshot + FTS (NOT SoR)
```

## Architecture (historical package-A · demo only · DO NOT use as SoR)

```
electron-main (IPC only) — DEMO PROFILE ONLY
  └─ services/ + sqlite cache (sql.js|better-sqlite3) — NOT multi-user authority
```

## Package-A DoD (08-12)

See amendments A1 + A4 + A5.



---

# Dual Voices (executed)

## CEO SUBAGENT — strategic independence
Critical: stack-picking ≠ 08-12 risk; timebox 6h unrealistic; Chinese FTS seed-only is staged demo; S1+S2 double-implement; main-process god services need ports; better-sqlite3 native risk; web-first alternative dismissed fast; Agent narrative vs clipboard search; dual UI complexity; autofill UI honesty; import not package-A.

## ENG SUBAGENT — independent
Critical: Chinese FTS tokenization; hit/no_hit threshold missing; adoption lifecycle; importScripts path security; redaction empty; Electron security flags; FTS triggers; version snapshot; package-A E2E must; better-sqlite3 rebuild.

## DESIGN SUBAGENT — independent
P0: adoption write timing; hit vs 1-2 results; ticket status mapping. P1: stream columns; empty escalate; filter empty ≠ no_hit escalate; toast wording no "已发送".

## CODEX (CEO+ENG combined)
P0: package-A DoD with evidence; Chinese eval set; autofill narrative honesty; FTS chinese; FTS content table/triggers; Electron isolation; autofill wrong-window risk. P1: event API query_id; import trust chain; mock role not security; DB backup not wipe; native packaging matrix; E2E not unit-only.

### CEO CONSENSUS TABLE
| Dimension | Codex | Subagent | Consensus |
|-----------|-------|----------|-----------|
| 1. Premises valid? | Partial (S1+S2 over-implement) | Partial | DISAGREE on severity only → **TASTE: S2=spec+tests not full UI** |
| 2. Right problem? | No — demo DoD not stack | No — package A not monorepo | **CONFIRMED: reframe to package-A slice** |
| 3. Scope calibration? | Over-scoped for week | Over-scoped | **CONFIRMED cut order** |
| 4. Alternatives explored? | Missing web-first | Missing sql.js default | **TASTE: Electron stay; single window** |
| 5. Risks covered? | FTS/autofill weak | FTS/native weak | **CONFIRMED add mitigations** |
| 6. 6-month trajectory? | Local god-object debt | Need service ports | **CONFIRMED Electron-free services** |

### DESIGN LITMUS (summary)
Hierarchy 6 → need stream-first dashboard; states 5 → add push/dismissed; specificity 4 → freeze columns/FAQ.

### ENG CONSENSUS TABLE
| Dimension | Codex | Subagent | Consensus |
|-----------|-------|----------|-----------|
| 1. Architecture | Weak IPC/security | Main-write OK, ports needed | **CONFIRMED harden** |
| 2. Tests | Missing E2E | Missing Chinese/E2E | **CONFIRMED package-A tests Must** |
| 3. Performance | OK local | OK | CONFIRMED |
| 4. Security | Critical IPC/import | Critical | **CONFIRMED** |
| 5. Error paths | Incomplete | Incomplete | **CONFIRMED state machines** |
| 6. Deploy risk | Native rebuild | Native rebuild | **CONFIRMED day0 gate** |

---

# Auto-decided plan amendments (applied)

## A1. Two-layer delivery (Mechanical · P3)

**08-12 Package-A runtime (only):**
1. Seed DB (`pnpm seed`) — not live Feishu import UI\
2. FTS/n-gram search + **exact/LIKE fallback** for demo phrases\
3. Float: paste → Top3 → **clipboard button primary label**\
4. Events: search creates query_id+impressions; adopt once; escalate on empty CTA click\
5. Dashboard: **listQueries only** + highlight last query_id (KPI optional collapsed)\
6. Ticket close: seed tickets + 3-state UI mapped to schema\

**S2 (same week docs+tests, not all UI):**
- `schema.v1.sql` + migrations\
- Service ports without Electron import\
- Redaction rules + unit tests\
- Import path security design (dialog in main only)\
- Autofill adapter stub **not exposed as primary CTA**

## A2. Stack freeze (updated)

| Item | Decision |
|------|----------|
| Language | TypeScript |
| Shell | Electron (product end-state); **08-12: single BrowserWindow**, float panel + dashboard route/tab |
| UI | React 18 |
| Tooling | electron-vite + pnpm |
| DB | better-sqlite3 **with day-0 rebuild gate**; document exact Electron version; if gate fails → **sql.js path for demo only** |
| Search | FTS5 **character n-gram (bi-gram)** index on questions + `normalize()` + MATCH escape; **fallback LIKE/exact** for package-A phrases |
| hit rule | `count(results) >= 1` after filters = hit; 0 = no_hit; never pad fake cards |
| adopt rule | click → terminal `adopted` once; then push; update `push_method` clipboard|autofill|failed; demo pass if clipboard OK |
| ticket map | 已处理→resolved; 忽略→wont_fix; 延期→open+note=defer |
| Security | contextIsolation, sandbox, no nodeIntegration; preload whitelist; zod on IPC; import via dialog only |
| Services | `services/*` **must not import electron** |

## A3. Cut order if timebox slips

1. Ticket UI → seed-only close via SQL\
2. KPI strip → hide\
3. Autofill → never show\
4. Dual window → single window tabs\
5. Import UI → `pnpm seed` only\
**Never cut:** search→clipboard→same query_id on dashboard\

## A4. Chinese eval set (package A)

- Freeze **15** standard demo queries (must hit)\
- **3** paraphrase (must hit)\
- **3** intentional no-hit (empty+escalate)\
Owner: content/demo operator\

## A5. Calendar (replace 6-hour fantasy)

| Day | Deliverable |
|-----|-------------|
| D0 | Toolchain+Electron versions lock; sqlite native gate |
| D1 | schema+seed+search API unit tests |
| D2 | float paste/Top3/clipboard + events |
| D3 | dashboard stream same query_id |
| D4 | empty+escalate+ticket close seed |
| D5 | package-A runbook dry-run + buffer |

---

# Taste decisions (for final gate)

**T1. Primary SQLite driver**\
- Recommend: **better-sqlite3** + day0 gate, sql.js emergency only\
- Alternative: **sql.js default** for demo reliability\

**T2. Window model 08-12**\
- Recommend: **single window** tabs (float | dashboard)\
- Alternative: two always-on-top windows (product closer, more bugs)\

**T3. Autofill UI honesty**\
- Recommend: primary CTA **「复制到剪贴板」**; autofill experimental only\
- Alternative: keep 「自动填入」label with silent clipboard fallback (risk: expectation fail)

---

# User Challenges

None that reverse product contract. Models challenge **delivery packaging** (slice vs full S2 UI), which strengthens package-A — aligned with user frozen 31.

---

# Cross-phase themes

1. **Chinese search quality** — CEO+Eng+Codex\
2. **Package-A minimal vs full monorepo ambition** — all phases\
3. **Security theater vs real IPC/import controls** — Eng+Codex\

---

# Decision Audit Trail (full)

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|-------|----------|-------|-----------|-----------|----------|
| 1 | CEO | Node/TS Electron | Mechanical | P5 | One language | Python/Tauri |
| 2 | CEO | Package-A slice vs full S2 UI | Mechanical | P3 | Dual voices | Build all UI week1 |
| 3 | CEO | Service ports no electron | Mechanical | P5 | 6mo debt | God main only |
| 4 | Design | Stream-first dashboard | Mechanical | P1 | Demo narrative | KPI-first |
| 5 | Design | Full answer + max-height scroll | Mechanical | P5 | Contract | Score badges |
| 6 | Eng | hit = ≥1 result | Mechanical | P5 | Metrics | Pad to 3 |
| 7 | Eng | adopt then push_method update | Mechanical | P5 | Design P0 | Ambiguous |
| 8 | Eng | n-gram FTS + exact fallback | Mechanical | P1 | Chinese | unicode61 only |
| 9 | Eng | IPC security baseline | Mechanical | P1 | Codex/subagent | Trust renderer |
| 10 | Eng | seed not import UI for 08-12 | Mechanical | P3 | CEO | Live Feishu import |
| 11 | Eng | better-sqlite3 + day0 gate | Taste | P3 | Perf | sql.js default |
| 12 | Design | single window tabs | Taste | P3 | Stability | Dual windows |
| 13 | Eng | clipboard primary CTA | Taste | P5 | Honesty | Autofill primary label |

---

# Completion Summary

| Phase | Result |
|-------|--------|
| CEO | Selective expansion; cut to package-A runtime |
| Design | UI scope yes; states+FAQ frozen |
| Eng | Architecture+tests+security amendments |
| DX | Internal TTHW <30m with seed script |

**Plan status after autoplan:** READY FOR APPROVAL with 3 taste choices.
