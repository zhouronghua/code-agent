# 保底模型切换后卡住 / 继续报接口异常 —— 根因与修复

## 现象

两个独立症状，都发生在 `deepseek-flash → gpt-5.6-luna` 切换之后：

1. **卡住**：切到保底模型后会话像冻住，不再前进，也回不到主模型。
2. **继续报接口异常**：切换成功后紧接着每个请求都失败。

## 取证方法

不猜，直接读任务日志。`~/.agents/tasks` 共 2809 条任务日志，其中 **45 条**发生过
`model-fallback`，这些里有 **25 条最终 failed**。按错误文本分类：

| 任务数 | 错误 |
|--------|------|
| 90 | other |
| 44 | timeout |
| 14 | 502 |
| **11** | **`Unknown parameter: 'thinking'`** |
| 8 | upstream 500 |
| 5 | context length |

关键判据：把「fallback 发生时刻」和「该时刻之后的 step 数」对齐，**4 个案例在 fallback 之后
steps = 0** —— 一次成功请求都没有，保底模型的第一个请求就把任务打死了。这解释了为什么是
「几次」而不是每次。

---

## 根因 1：保底模型的 max_tokens 超出网关上限（"继续报接口异常"）

`~/.agents/models.json` 给 `gpt-5.6-luna` 配了 `maxOutputTokens: 393216`，但网关实际只接受
**128000**。实测确认（真实网关）：

```
max_tokens 393216 -> 400 {"error":{"message":"max_tokens is too large: 393216.
                        This model supports at most 128000 completion tokens"}}
max_tokens 128000 -> 200 OK
max_tokens 128001 -> 400
max_tokens 131072 -> 400
```

`_clampMaxTokens()` 的返回是 `min(maxOutputTokens, remaining)`：

- **历史短** → `remaining` 大 → 取到 393216 → **400 打死** ← 切换后立刻失败
- **历史长** → `remaining` < 128000 → 恰好合法 → 保底模型「有时能用」

这就是"有时报错、有时能用"的机制。任务日志里 `yhe5i5` 跑 7.3 小时、多次
`primary-recovered`，正因为它历史够长而躲过了这个 400。

**修复**：新增 `parseMaxTokensCap()`，从 400 里读出网关真实上限并记住
（`_completionCap`），`_clampMaxTokens()` 把它作为硬上限。上限从错误里学，不硬编码——
它是网关属性，换个部署可能不同。

## 根因 2：两个自愈互相禁制（叠加失败）

`thinking` 参数网关不支持时，已有 `_skipThinking` 自愈。但**两个问题叠加时**仍然失败：
旧的 thinking 自愈调用 `_doComplete(..., allowRetry=false)`，把 max_tokens 自愈也一起关掉了，
于是第二个 400 无人处理。而 gpt-5.6-luna **恰好两个问题都有**。

**修复**：三类修复（temperature / thinking / reasoning_content echo）重发时都保留
`allowRetry=true`，各自由独立的一次性标志保护，不会循环。真实网关验证：

```
[LLM] gpt-5.6-luna does not implement the 'thinking' parameter — resending the request without it
[LLM] gpt-5.6-luna caps completion at 128000 tokens (configured 393216) — resending with a legal max_tokens
REAL GATEWAY SUCCESS in 4361 ms -> "PONG"
```

## 根因 3：`_llmRequestInFlight` 只在成功路径复位（"卡住"）

```ts
this._llmRequestInFlight = true;
for (;;) {
  try { ... } catch { throw err; }     // ← 抛错时直接跳出
}
this._llmRequestInFlight = false;      // ← 只有成功才执行
```

这个标志是恢复探测的闸门：为 true 时探测走「有请求在飞，延迟到下一轮再切回」分支。请求抛错
（保底模型自己 400、网络断、任务被取消）后标志永久为 true，而**下一轮可能永远不来**——探测
就一直延迟到一次不存在的迭代，agent 永远停在保底模型上。

测试里直接复现了这一点：

```
[MODEL] primary model reachable again — switching back at the next step
FAIL: the agent returned to the primary instead of staying stuck on the 保底 model
```

**修复一**：把请求循环包进 `try { … } finally { this._llmRequestInFlight = false; }`，
成功、抛错、取消三条路径都复位。

**修复二**（取消路径仍卡）：`_primaryRecovered` 只在循环顶部被消费。若运行在消费之前结束，
延后的切回就丢失了。在 `run()` 的 `finally` 里补上兜底消费，并在那里真正执行切回。

## 根因 4：不可达的主模型不触发 fallback（"接口异常"的另一半）

`isApiTimeoutError()` 只认 `timeout` / `ETIMEDOUT` 这类字面量。而当主模型主机不可达时，Node
抛的是 `fetch failed`（cause 为 `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN`），**完全匹配不上**，
于是 `classifyApiFallback()` 返回 undefined，不走保底，任务直接以 `fetch failed` 结束。

从 agent 的角度看，这与超时是同一个条件：主模型服务不了这个请求。已把连接层错误纳入同一分类
（`fetch failed` / ECONNREFUSED / ECONNRESET / ENOTFOUND / EAI_AGAIN / network /
socket hang up）。

端到端实测（主模型指向不可达地址）：

```
[LLM Retry] Network error (attempt 3/3)
[MODEL] ⚠ broken-primary unreachable → switched to 保底模型 gpt-5.6-luna,
        retrying the same request (timeout: fetch failed)
[LLM] gpt-5.6-luna does not implement the 'thinking' parameter — resending ...
[LLM] gpt-5.6-luna caps completion at 128000 tokens (configured 393216) — resending ...
[AGENT] FALLBACKOK
```

修复前这条链路在第三步就 `ERROR fetch failed` 终止了。

## 验证

新增两个测试套件：

`tests/fallback-limits.test.ts`（21 项）—— 用本地 mock 网关复现两个真实 400：

- 首次请求确实发出超限值（复现 bug），重试遵守网关上限
- 上限从错误里学（8192 / 128000 两种网关都能满足）
- 学到后记住（第二次调用只发 1 个请求）
- 两个问题叠加也能一起修好
- 401 仍正常失败（不会无限修补）
- 错误识别不串味：`max_tokens` 400 不被误判为 thinking 问题，reasoning echo-back 400 也不被误判

`tests/fallback-stuck.test.ts`（14 项）—— 固定"不卡住"的不变量：

| 场景 | 断言 |
|------|------|
| 保底模型请求失败 | 探测能立刻切回主模型（原来永久卡住） |
| 运行成功 | 标志清空，能切回 |
| 运行被取消 | 标志清空，延后的切回不丢失 |
| 请求确实在飞 | 仍然延后切回（这个行为必须保留，否则响应来源会被标错） |

全量 17 套测试通过。真实网关上，短历史与中等历史两种情形都成功返回。

## 交付清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/vs/workbench/services/agent/browser/llmOpenai.ts` | 改 | `parseMaxTokensCap`、`_completionCap`、clamp 接上限、三类自愈保留 allowRetry |
| `src/vs/workbench/contrib/agent/common/agent.ts` | 改 | `_llmRequestInFlight` 移入 finally、run 结束兜底消费 `_primaryRecovered`、连接层错误纳入 fallback 分类 |
| `tests/model-switch.test.ts` | 改 | +4 项连接层错误分类断言（共 123 项） |
| `tests/fallback-limits.test.ts` | 新增 | 21 项 |
| `tests/fallback-stuck.test.ts` | 新增 | 14 项 |

## 遗留观察（未修，建议单独处理）

`~/.agents/tasks` 里还有 **14 条 502** 和 **8 条 upstream 500**，都是网关侧错误。
`MAX_RETRIES = 3` 且 5xx 在 `RETRYABLE_STATUS_CODES` 里，理论上会重试；这些任务最终失败说明
网关侧故障持续时间超过了重试窗口。属于上游可用性问题，不是本客户端的缺陷。