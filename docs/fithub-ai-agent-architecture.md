# FitHub AI Agent · 当前实现与架构

> 日期：2026-11-02  
> 范围：`fithub-ai` 对话主 agent + 体育部主线 M1–M3；后端交接持久化在 `fithub-rust`（`ai_demo`）/ 库 `fithub_ai_demo`。  
> 产品逻辑依据：`清爽版-对外同步/`（第一版做到 M3，B 支线未纳入实现）。

---

## 1. 一句话

教练在 Web 对话里提问 → `fithub-ai` 用 **ReAct 工具轨**办事 → 规划类需求走 **M1→M2→M3**，每站交接物（H1/H2/H3）写入 Postgres 流水线表；**不**写入 `period_plan` 等业务课表。

---

## 2. 仓库与运行角色

| 组件 | 路径 | 职责 |
|---|---|---|
| 对话服务 | `fithub-ai/` | 主 agent、工具、M1–M3 合成、记忆 |
| 业务后端 | `fithub-rust/`（分支 `ai_demo`） | 鉴权、学员/评估等业务 API、`ai_pipeline_*` 读写 |
| Web | `fithub-web/` | `/home/ai` 对话 UI，转发到 `fithub-ai:4000` |
| 演示库 | Postgres `fithub_ai_demo` | 与 `fithub_dev` 隔离；`.env.local` 里 `DATABASE_AI_URL` 优先 |

本地后端切换库：设置 `DATABASE_AI_URL` 则优先连演示库；注释掉则回落 `DATABASE_URL`（`fithub_dev`）。

---

## 3. 总架构

```
教练 / Web
    │  POST /api/v1/ai-chat
    ▼
fithub-ai ChatService
    │
    ├─ 无门禁续聊？ ──► runReactTurn（工具循环）
    │                      │
    │                      ├─ 只读工具 → BACKEND 业务 API
    │                      ├─ start/advance_pipeline_* → BACKEND ai_pipeline API
    │                      ├─ dispatch_framework/review → handoff 旧门禁
    │                      └─ 纯文本回复 → 结束
    │
    └─ 有 pending/strategy/activeGate？ ──► runParentTurn（分类器续聊）
                                              └─ 伤病确认 / 补策略 / confirm·revise
```

**原则**

- 新开只读查询、首次拉起规划/排课/复盘 → ReAct。
- 排课伤病确认、策略补全、待确认草案 → 门禁分类器（`activeGate`）。
- 写入业务课表仍挡着；规划交接写入由 pipeline 工具经后端完成。

---

## 4. 主对话：ReAct + 门禁双轨

### 4.1 ReAct 轨

- 入口：`src/chat/handle.ts` → `src/parent/react.ts`
- 策略提示：`agents/parent/react.md`
- 消息历史：`ParentState.messages`（user / assistant / tool）
- 工具注册：`src/tools/registry.ts`（禁止注册本地 `WRITE_TOOLS`）

**工具分组**

| 组 | 名称 | 作用 |
|---|---|---|
| 只读 | `list_my_athletes` / `get_athlete_tags` / `check_assessment` / `list_period_plans` | 查业务库 |
| 规划 | `start_training_pipeline` / `advance_pipeline_m2` / `advance_pipeline_m3` | M1–M3 → H1–H3 |
| 旧派发 | `dispatch_framework` / `dispatch_review` | 交回旧排课/复盘门禁（过渡） |

### 4.2 门禁续聊轨

- `needsGateContinuation(state)`：存在 `pending` / `strategy` / `activeGate` 时跳过 ReAct。
- 分类器：`agents/parent/prompt.md` + `src/parent/classify.ts` / `turn.ts`
- `dispatch_*` handoff 后带强制 `decision`，不再二次分类。

### 4.3 记忆与上下文预算

- 长期记忆：教练/学员索引文件层 `src/memory/`；**ReAct 与门禁都会读索引**。
- 工作态：每轮把学员/门禁/待确认写进 system（`formatWorkingState`）。
- 短期：落盘可留最多 120 条；给模型的是 **token 近窗**（约 20k）+ 超阈值时滚动的 `sessionSummary`（`src/parent/contextBudget.ts`）。UI 不因摘要删历史。
- Tool 结果限长（约 1500 字）；学员列表默认只露前 10 人。
- 写入：ReAct 仅在本轮用过只读工具时抽取；门禁路径在 `concluded` 时抽取。不上向量库。

---

## 5. 体育部主线 M1–M3

产品文档：`清爽版-对外同步/M1–M3` + `附件-交接接口格式-v1.md`。  
实现：`fithub-ai/src/pipeline/` + `src/tools/pipeline.ts`。

```
原话
  → M1 buildH1 / start_training_pipeline     → H1
  → M2 buildH2 / advance_pipeline_m2         → H2
  → M3 buildH3 / advance_pipeline_m3         → H3
```

| 站 | 代码 | 输入要点 | 输出（handoff） |
|---|---|---|---|
| M1 | `pipeline/m1.ts` + `agents/parent/module-lexicon.json` | 原话、可选用户类型 | 用户类型 + 主/辅模块 |
| M2 | `pipeline/m2.ts` | 伤病说明、门禁、档案关节标签、是否有评估 | 红线、模块三态、入口、强度区间骨架 |
| M3 | `pipeline/m3.ts` | 已采纳 H1/H2 + 频率/偏好/时长 | 模块级周计划 + 八子档案壳 |

**裁决（实现侧）**

- 红线转介：写 H2 后停止，不合成 H3。
- H3 剔除 H2 中 🔴 模块；🟡 进入 `flagged`。
- 仅当门禁未过时，入口模块可压过目标主模块。
- H3 **不**选动作、**不**定组次负荷（留给 M4–M8）。

每站工具在缺上游 accepted 交接时，会尝试 `accept` 最新 draft，再继续。

---

## 6. 持久化

### 6.1 表（仅演示库已迁）

迁移：`fithub-rust/migrations/20261030163000_create_ai_pipeline_tables.*.sql`

| 表 | 含义 |
|---|---|
| `ai_pipeline_run` | 一次规划会话；学员同时至多一条 `drafting` / `awaiting_confirm` |
| `ai_handoff` | H1–H9 版本链；`payload` JSONB；同 run+H 至多一条 `accepted` |

### 6.2 HTTP API（`/hex/web/ai_pipeline`，需登录）

- `run/create` · `run/get` · `run/abandon`
- `handoff/append` · `handoff/accept` · `handoff/list`

应用层：`fithub-rust/src/hex/application/ai_pipeline/`  
仓储：`.../postgres/ai_pipeline_repo.rs`

### 6.3 会不会进业务课表？

| 写入目标 | 当前 |
|---|---|
| `ai_pipeline_run` / `ai_handoff` | ✅ 会（工具调用时） |
| `period_plan` / `workout` / `user_tag` 等 | ❌ 不会 |

---

## 7. 关键目录速查（fithub-ai）

```
fithub-ai/
  agents/parent/
    react.md              # ReAct 策略
    prompt.md             # 门禁续聊分类器
    module-lexicon.json   # M1 模块触发词
  src/
    chat/handle.ts        # 对话入口、双轨调度
    chat/business.ts      # 后端 HTTP 客户端（含 pipeline）
    parent/react.ts       # ReAct 循环
    parent/turn.ts        # 旧/门禁主循环
    parent/handoff.ts     # dispatch → decision
    pipeline/m1.ts|m2.ts|m3.ts
    tools/readonly.ts|pipeline.ts|dispatch.ts|registry.ts
    memory/               # 记忆抽取与落盘
  test/pipeline-m*.test.ts
```

---

## 8. 与旧「框架站 / CSCS Slot」的关系

- `agents/framework/`、站式编排与规则卡仍在，对应早期「会话内生成框架、确认后写库」路径。
- **规划主路径已切到清爽版 M1–M3**；`dispatch_framework` 为过渡保留。
- 框架确认写库、复盘子 agent 仍为占位/拦截，未接正式产品写入。

---

## 9. 已完成 / 未做

**已完成**

- ReAct + 门禁双轨、会话历史、只读能力白名单  
- M1–M3 合成与工具、H1–H3 落库 API  
- 演示库隔离与 `DATABASE_AI_URL`  
- 相关单测（规划与对话壳）

**未做（有意推迟）**

- M4–M9（slot、动作检索、课内执行、周结算）  
- H3 投影到 `period_plan`  
- 五份评估真数据驱动门禁（现多为入参/推断）  
- 复盘子 agent 完整实现  
- 向量库  
- 拆净旧框架站主路径  

---

## 10. 建议联调路径

1. 后端：`ai_demo` + `DATABASE_AI_URL=.../fithub_ai_demo`，`cargo run`  
2. `fithub-ai` + Web 对话  
3. 「给甲做减脂周计划」→ 应依次触发 pipeline 工具  
4. SQL 抽查：`ai_pipeline_run` / `ai_handoff` 是否出现 H1→H2→H3  

---

## 11. 文档与代码权威

- 产品口径：`清爽版-对外同步/`（定稿层；B 未实现）  
- 运行实现：以本仓库 `fithub-ai` + `fithub-rust` 上述路径为准  
- 本文描述「当前已落地状态」，后续演进请同步改此文或另开版本说明  
