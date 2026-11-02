# 从 deepseek-harness (dsh) 借鉴的能力

调研对象：`~/work/code/deepseek-harness`（dsh 0.2.1-rc.5，HEAD `ce7073d512`，2026-10-30）。

dsh 是一个插件化（cordis 依赖注入）的大型 agent 平台，`packages/` 下有 54 个包。它的
**架构**不适合搬进 code-agent（cordis 容器、session projection、S2 存储、WebUI 插件生态），
但它近期的改动里有几项是**纯本地、低风险、可单测**的机制，已移植如下。

选择标准：

1. 修复 code-agent 已存在的**具体缺陷**或真实体验缺口（不是"dsh 有所以我们也要有"）；
2. 不引入依赖（code-agent 的 bundle 必须保持零运行时依赖）；
3. 能用本地单测闭环验证，不需要真实模型/设备。

---

## 1. 文件改动 diff 高亮（已实现）

**来源**：`packages/fs/tool-fs/src/diff.ts` + `apply-patch-presentation.ts` +
`docs/tool-catalog.md`（`FileDiff` 结果 payload + presentation 层，每个 hunk 一张卡片）。

**问题**：`edit_file` 只回答 `Replaced 1 occurrence(s) in /path`，`write_file` 只回答
`Successfully wrote N lines`。看着会话的人必须事后再 diff 一遍才知道 agent 到底改了什么。
Claude Code / Codex / Cursor / aider 都会显示彩色 diff，这是这类工具的基本预期。

**实现**（`src/vs/workbench/contrib/agent/common/agentDiff.ts`）：

- `computeFileDiff(path, before, after)` — 行级 LCS unified diff，3 行上下文，带双侧行号。
  先裁剪公共前后缀，所以真实的编辑只在一小段上建表；表超过 4M 格退化为
  "前缀+后缀之间整段改变"（仍然正确，只是更粗），避免 10 万行重写把 REPL 卡死。
- `renderFileDiffAnsi(diff, {color, displayPath, maxLines})` — 终端卡片
  `┌─ path (+3 -1) / │ @@ -hunk @@ / │ -old / │ +new / └─`。
  `maxLines` 兜底，一次巨型重写不会刷屏。
- `renderFileDiffPlain()` — 无 ANSI 版本，给批次日志/任务日志用（那里 ANSI 是噪声，甚至
  会污染机器读取的产物）。
- 路径相对化在**渲染侧**做（`displayPathFor`），因为只有 host 知道 CWD。

**关键设计**：diff 是 **display-only**，放在新字段 `IToolResult.diff`，**不进 `output`**。
原因：

- `output` 是模型看到的内容；把彩色 diff 塞进去会白烧 context，还会把 ANSI 转义序列送进
  tokenizer 和模型；
- 卡片经由 `AgentLoop.onDidReceiveToolDiff` 事件发给 host，由 host 决定颜色和路径长度。

`write_file` 会先读旧内容（文件不存在 → 空基线 → 整篇显示为 `+`），因此"新建文件"和
"覆盖已有文件"都能显示真实 before/after。

**验证**：`tests/diff-render.test.ts`（51 项），覆盖计数、行号、双侧 hunk 范围、远距离变更
分块、新建/清空文件、超大重写降级、ANSI vs 纯文本、`NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`。

---

## 2. 运行中也能执行控制命令（已修复）

**来源**：不是从 dsh 抄的功能，而是调研 dsh 的 REPL 交互时发现的 code-agent **真实缺陷**。

**问题**：`agentLoop.run(task)` 在 await 期间，`rl.on('line')` 只有两条路：

```ts
if (trimmed.startsWith('/btw ')) { …注入给 agent… }
else { bufferedLines.push(trimmed); }        // ← 其余全部排队
```

于是 `/mode ask`、`/stream`、`/tasks`、`/sessions`、`/save`，甚至 `exit`，全都被静默排队，
必须等当前任务结束才生效。一个 20 分钟的 build 意味着 20 分钟的"死 REPL"——用户既不能切
模式、不能查会话、不能看任务日志，也不能退出。这些命令本身是**本地**的（只动 REPL 自己的
状态，不动 agent 的推理），根本不需要等。

**实现**（`src/vs/workbench/contrib/agent/common/agentReplInput.ts`）：

纯函数 `decideRunningLine(line, {agentRunning})` 把一行分成四条路由：

| 路由 | 命令 | 行为 |
|------|------|------|
| `btw` | `/btw …` | 注入运行中的 agent（hint / supersede / cancel） |
| `immediate` | `/mode` `/stream` `/auto-save` `/tasks` `/task` `/delete-task` `/sessions` `/delete-session` `/skills` `/profiles` `/help` `/save` `/cancel`、`exit`/`quit` | **立刻执行**，与 agent 并发（只动 REPL 状态或发取消信号） |
| `buffer` | 真实 prompt | FIFO 排队，等当前任务结束（两个 prompt 不能共享同一个 context window） |
| `refuse` | `/profile` `/resume` `/new` `/parallel` `/skill` `/use-skill`、未知命令 | **明确拒绝并说明原因**，不再静默排队 |

拒绝的理由都写在代码里：`/profile` 中途换 provider 会让运行中的 loop 指向已 dispose 的
provider；`/resume` `/new` 会替换运行中的 loop 正在写的消息历史；`/continue` 在
`AgentLoop` 里本身就会抛 `Agent is already running`。

**顺带修复的三个 bug**（都是同一段代码）：

1. **`/help` 等命令没有 handler**：Tab 补全会列出 `/help`、`/session`、`/delete-session`、
   `/use-skill`、`/cancel`，但 REPL 里**没有对应分支**，于是 `/help` 被当成 prompt 发给模型
   （等于让模型"执行 /help"）。现已补齐 `/help` `/delete-session` `/use-skill` `/cancel`，
   并删除并不存在的 `/session`（`/sessions` 才是真命令）。
2. **参数缺失的命令被转发给模型**：`/task`、`/mode` 不带参数时落到"任务执行"分支。现在给出
   usage 提示。
3. **`modeLabel` 是启动快照**：`/mode` 切换后 prompt 仍显示旧模式。改为从
   `AgentModeManager.currentMode` 实时读取。

**排队路径同样重新分类**：`drainBufferedLines()` 对每条积压的行再跑一次 `decideRunningLine`，
所以"打字慢了一拍"的命令不会因为进了队列就变成任务。纯命令批次（`/help` 后跟 `/tasks`）
也不会再卡在队列里。

**验证**：`tests/repl-control-during-task.test.ts`（145 项）。其中一组专门断言 Tab 补全里
**每一个**命令都不会被当成 prompt；另一组断言 `/continue` 在 `agentRunning:false` 时是
`immediate`、在 `true` 时是 `refuse`（同一个命令的两种正确行为）。

真机验证（PTY，任务运行中键入）：`/tasks` 与 `/mode ask` 立即执行并打印 `[NOW]`；
`/btw cancel` 打断了 30 秒的 `sleep 30`；`exit` 立即退出并保存会话。

---

## 3. 工具结果 head+tail 保留（已实现）

**来源**：`packages/spill/spill-policy/src/retention.ts` +
`packages/compaction/compaction-tool-result-pruner/src/config.ts`（
`thresholdChars: 8192 / headChars: 4096 / tailChars: 1024` + 精确省略提示）。

**问题**：code-agent 原来只有 `substring(0, 8000)`——对最重要的那几类输出，**恰好保留了没用
的那一半**：

| 输出 | 有用部分在哪 |
|------|--------------|
| 失败的 `pytest` | 断言 + `1 failed, 399 passed` 摘要 → **最后几行** |
| 编译错误 | diagnostic → **最后几行** |
| `npm test` | pass/fail 计数 → **最后几行** |
| 长 `git diff` | 通常是尾部 |

结果是 agent 看到 8000 字准备阶段的噪声 + 一个 "truncated" 标记，然后只能重跑一次并
`| tail`。dsh 保留有序的 **head + tail**，中间放精确的省略提示。

**实现**（`src/vs/workbench/contrib/agent/common/agentResultRetention.ts`）：

- `retainResult(text, {maxChars, headChars, tailChars, marker})` → `{text, truncated,
  omittedChars, headChars, tailChars}`；未超预算时原样返回（一次长度比较的成本）。
- 默认 8000 / 4000 / 2000，与旧上限一致（不改变 context 预算）。
- 省略提示带**精确**被丢弃的字符数和位置，agent 可以据此决定"用更窄的范围重跑"，而不是猜
  丢了多少。
- `safeSlice()` 保证不切断 surrogate pair：否则边界上的 emoji/CJK 扩展 B 字符会变成
  `U+FFFD`，静默污染模型读到的文本。
- `headChars + tailChars >= maxChars` 直接报错——保留后的文本不允许比原文更长。

**验证**：`tests/result-retention.test.ts`（35 项）。核心一组用真实形态的 pytest 日志断言
`1 failed, 399 passed in 12.41s` 和断言行**必须**在保留结果里，同时断言中间行被丢弃。

---

## 4. `todo_write` 任务清单（已实现）

**来源**：`packages/todo/tool-todo/src/index.ts`（整表替换 + `allowParallelInProgress`
配置 + 结构与校验）。

**问题**：多步任务运行时，终端只有一串 tool call，用户和 agent 都看不出"做到第几步、还剩
什么"。code-agent 的 `AgentPlanner` 是 **Plan 模式**的一次性 JSON 计划，与执行脱节
（`advanceStep()` 由循环自动推进，模型无法主动更新）。

**实现**（`src/vs/workbench/contrib/agent/common/tools/todoWrite.ts`）：

- 语义与 dsh 对齐：
  - **整表替换**（last write wins），没有逐项编辑/删除——模型每次必须陈述完整计划，永远
    不会留下"删了一半"的陈旧列表；
  - `content` 必须非空且唯一（重复会让"把 X 标记完成"变得有歧义）；
  - 最多一个 `in_progress`（本 CLI 是串行的，"多个进行中"不可能是真的；dsh 把它做成
    `allowParallelInProgress` 部署选项，这里固定为 false，但 `canonicalizeTodos(raw, true)`
    保留了 dsh 的并行语义以便复用）。
- 校验失败是**失败结果**而不是静默修正：模型以为写了"3 项、2 个进行中"，不能告诉它成功。
- 清单对象由 `AgentLoop` 持有（`registerTodoTool()` 注册工具），因为"新任务清空旧计划"是
  loop 的语义。
- 渲染经 `onDidUpdateTodos` 事件发给 host：`Plan (1/3 done, 1 in progress)` + `[x]/[~]/[ ]`。
  与 diff 一样，**不进消息历史**——否则模型每轮都要重读自己的计划。

**验证**：`tests/todo-list.test.ts`（39 项）+ 真机三步任务（清单 0/3 → 1/3 → 2/3 → 3/3 逐轮
渲染正确）。

---

## 调研过但**没有**移植的部分

记录理由，避免以后重复评估。

| dsh 能力 | 包 | 不移植的原因 |
|----------|-----|-------------|
| `apply_patch`（Codex 风格多文件补丁） | `fs/fs-patch`, `fs/tool-fs` | 需要整套 patch 解析/预检/提交/回滚层（519+350 行）。code-agent 的 `edit_file` + `write_file` 已够用；多文件编辑是**新增工具**而非修缺陷，性价比低于上面四项。是本轮最值得作为下一步做的项。 |
| spill 文件（超限结果落盘 + locator） | `spill/*` | 需要 session 作用域目录、0700 权限、exclusive write 防符号链接、retention 策略。code-agent 已有 `--state-dir` 与 head+tail 保留；落盘的价值主要在多模态大结果，本 CLI 只有文本。 |
| `job_list/job_output/job_kill` 后台作业 | `jobs/*` | code-agent 已有 `poll`（自带等待预算）+ `run_terminal`，且 `poll` 的语义对 CI 场景更直接。 |
| 插件系统 / session projection / S2 存储 | `boot`, `session`, `storage` | cordis 依赖注入容器的整体架构迁移，与 code-agent 的 VS Code contribution 分层冲突。 |
| PTC `run_code`（代码内调用工具） | `tool-executor-ptc` | 需要独立 runtime + 生成的 SDK + 子调用桥接；收益主要在长编排，本 CLI 的 ReAct 循环已覆盖。 |
| `ask_user_question` 结构化提问 | `tool-ask-user` | code-agent 是 REPL，用户本来就能直接回答；`/btw` 覆盖了并发干预场景。 |
| trajectory subcall folding / code highlight | `web/*` | 纯 WebUI 呈现，CLI 无对应表面。 |

---

## 交付清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/vs/workbench/contrib/agent/common/agentDiff.ts` | 新增 | unified diff + ANSI/纯文本渲染 |
| `src/vs/workbench/contrib/agent/common/agentReplInput.ts` | 新增 | 运行中命令行路由（纯函数） |
| `src/vs/workbench/contrib/agent/common/agentResultRetention.ts` | 新增 | head+tail 保留 |
| `src/vs/workbench/contrib/agent/common/tools/todoWrite.ts` | 新增 | `todo_write` 清单 |
| `src/vs/workbench/services/agent/common/agentModels.ts` | 改 | `IToolResult.diff` + `IToolDiff` |
| `src/vs/workbench/contrib/agent/common/agent.ts` | 改 | 两组事件、保留策略、清单归属 |
| `src/vs/workbench/contrib/agent/common/tools/editFile.ts` | 改 | 产出 diff |
| `src/vs/workbench/contrib/agent/common/tools/writeFile.ts` | 改 | 产出 diff（含新建） |
| `src/vs/workbench/contrib/agent/common/agentPrompts.ts` | 改 | `todo_write` 使用指引 |
| `vs-core/node-runtime/main.ts` | 改 | 命令分发器拆分、四个缺失命令、diff/清单渲染 |
| `tests/diff-render.test.ts` | 新增 | 51 项 |
| `tests/repl-control-during-task.test.ts` | 新增 | 145 项 |
| `tests/result-retention.test.ts` | 新增 | 35 项 |
| `tests/todo-list.test.ts` | 新增 | 39 项 |