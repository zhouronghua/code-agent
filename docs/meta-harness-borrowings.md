# 从 Meta-Harness 借鉴的 harness 能力

调研对象：`~/work/code/meta-harness`（Stanford IRIS Lab，*Meta-Harness: End-to-End
Optimization of Model Harnesses*, arXiv 2603.28052）。

该仓库本身是「在固定基座模型之外，自动搜索 harness 代码」的外层框架（proposer +
controller + 评测套件），它的**框架**不适合搬进 code-agent（需要 Harbor/Modal/TB2 数据集、
按美元计的评测预算）。有价值的是它两个参考实现里被验证过的 **harness 机制**，这些机制是
纯本地、低风险、可单测的：

| 来源 | 机制 | 在 code-agent 的落点 |
|------|------|----------------------|
| `reference_examples/terminal_bench_2/anthropic_caching.py` | 给 Anthropic 请求打 `cache_control: {type: ephemeral}` 断点（system + 最近消息） | `llmAnthropic.ts` |
| Terminus2 `_summarize` / 溢出回退（`original_instruction + Current state`）、prompt 模板里"提交前重读任务并确认最小改动"的收尾检查 | 压缩必须是**交接**：目标语句不能被摘要掉 | `agentContext.ts` + `agent.ts` |

## 1. Anthropic prompt caching（已实现）

`anthropic_caching.py` 对 Anthropic 模型给最近 3 条消息加 `cache_control`。ReAct 每轮都会
重发同一段前缀（system prompt + 增长中的对话），不打断点时这部分按全价计费；打上之后变为
cache read（约 10% 输入价），同时降低首 token 延迟。

实现（`llmAnthropic.ts`）：

- `systemBlocksForCaching()`：system prompt 变成带 `cache_control` 的内容块（最稳定的前缀）；
- `markCacheBreakpoint()`：把断点标在消息的**最后一个块**上（`text` / `tool_use` /
  `tool_result` 都支持），对最新 2 条消息生效；
- 断点总数 = 1（system）+ 2 ≤ Anthropic 上限 4；
- `stream()` 与 `complete()` 复用同一个 `_buildBody`，行为一致；
- **降级**：某些网关不认识该字段会返回 400。`_request()` 检测到 400 且错误信息里出现
  `cache_control` 时，自动去掉断点重试一次，并把这个 provider 实例的缓存**永久关闭**
  （`promptCachingDisabled` / `promptCachingDisabledReason` 可观测）。缓存只是优化，
  绝不能变成新的失败来源；
- **可达性**：node CLI 入口（`vs-core/node-runtime/main.ts`）原先只 import 了 `llmOpenai`，
  于是 `provider: anthropic` 在 CLI 上直接报 `Unknown LLM provider: anthropic`。本次一并注册
  `llmAnthropic` / `llmOllama`（IDE 入口 `agentService.ts` 早就注册了三个），缓存代码路径才
  真正对交付产物生效。

## 2. 任务锚点 + 交接式压缩（已实现）

原实现里，滑动窗口先丢最老的消息、`compactIfNeeded()` 又把前半段摘要掉——而用户的原始任务
语句永远是最老的那条。于是长任务可能在"记了一半的目标"上继续优化。Terminus2 的处理方式是
溢出后用 `original_instruction + 当前状态` 重建提示词，本仓库落成两件事：

- `AgentContext.setTaskAnchor(content)`：把用户原话钉在滑动窗口**之外**，每次请求都原样重发
  （`getContextWindow()` 中紧随 system prompt），并计入 token 预算，因此不会被挤掉；
  `clear()` 会清掉它，`continueSession()` 显式保留，`restoreFromSession()` 从会话首条 user
  消息重新钉住；
- `compactIfNeeded()` 的 prompt 改为**交接摘要**：按顺序保留 ①原始任务与显式要求
  ②已做的决策与改动的文件 ③已跑过的命令/测试及结果 ④未完成项与下一步，并内联锚点原文；
  摘要器失败回退截断时锚点依然在。

## 其它被考察但**未**采用的机制（附理由）

| 机制 | 不采用的理由 |
|------|--------------|
| 外层进化循环（`meta_harness.py`：frontier/`evolution_summary.jsonl`/pending_eval） | code-agent 已有 `self-improve` + `agent_self_scan` 闭环，且该循环依赖 Harbor/Modal 与按美元计的评测预算 |
| `controller.py` 的 leakage 校验、`EvaluationState` 预算冻结 | 只有在"用隐藏任务套件给候选打分"时才成立，本地 CLI 没有这个信任边界 |
| `inspect_validate.py` 的"先验证再收尾"提示 | code-agent 已有 verification round（`MAX_VERIFICATION_ROUNDS`），语义重复 |
| TerminalKira 的 `analysis`/`plan` 强制字段 | 属于系统提示词与工具 schema 的整体改版，影响面大，收益未验证，暂不做 |
| `evaluate_harness` 工具、image_read 多模态 | 面向 Harbor 沙箱评测 / 终端视觉分析，与本地编码 agent 的路径不同 |

## 验证

```
npm run typecheck
npm run test:harness            # 68 断言：断点位置、断点上限、400 降级、非 cache 400 不重试、
                                # 锚点不被滑动窗口淘汰、锚点计入预算、交接 prompt、截断回退、agent 循环钉住任务
npm test                        # 全量：99 + 48 + 101 + 131 + 68 全通过
npm run build:release
npm run test:e2e-anthropic      # 安装级：用打包后的 build/agent-cli.js 打真实 HTTP mock，
                                # 断言请求体确实带 cache_control 与 pinned task；
                                # 场景 B 模拟"拒绝 cache_control 的网关"，CLI 仍然退出 0 且后续请求无断点
```
