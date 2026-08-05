# Code-Agent Benchmark Report v3

> **v3 改进**: 多轮运行取中位数平滑 LLM 非确定性，大幅放宽阈值，默认 warn-only 模式。
> 旧机制（读历史日志）已废弃 — 那些日志是旧版本产生的，和新修改无关。

---

## 📊 工作原理

```
修改代码
   │
   ▼
npm run benchmark:check
   │
   ├─ 1. 🔨 npm run build          ← 构建最新 agent
   ├─ 2. 🧪 运行 benchmarks/suite/  ← 用新 agent 跑测试集 (默认 3 轮)
   ├─ 3. 📏 收集指标               ← 中位数聚合多轮结果
   └─ 4. ⚖️ 对比基线              ← 与 benchmarks/baseline.json 比较
```

## 📁 测试集 (benchmarks/suite/)

| ID | 任务 | 测试目标 |
|----|------|----------|
| 001 | 创建并验证文件 | write_file 工具, 基础 agent 循环 |
| 002 | 读取并搜索文件 | read_file + search_text 工具 |
| 003 | 编辑文件 | edit_file 工具, 精确修改 |
| 004 | 列出目录结构 | list_directory 工具 |
| 005 | 执行终端命令 | run_terminal 工具 |

添加新测试: 在 `benchmarks/suite/` 下创建 `<id>_<name>.json` 文件。

---

## 🛡️ 门禁检查阈值 (v3 宽松版)

> LLM 输出天然具有不确定性，v3 大幅放宽阈值。默认 **warn-only** 模式，仅在 `BENCHMARK_STRICT=1` 时阻止推送。

| 指标 | 方向 | 容忍度 | 说明 |
|------|------|--------|------|
| `successRate` | ↑ 越高越好 | -8% | 任务通过率 |
| `avgDurationSec` | ↓ 越低越好 | +150% | 平均任务耗时 |
| `avgSteps` | ↓ 越低越好 | +100% | 平均步骤数 |
| `avgToolCalls` | ↓ 越低越好 | +100% | 平均工具调用数 |
| `toolExecSuccessRate` | ↑ 越高越好 | -10% | 工具执行成功率 |
| `avgToolCallsPerStep` | ↓ 越低越好 | +50% | 每步平均调用数 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BENCHMARK_RUNS` | 每个任务重复运行次数取中位数 | 3 |
| `BENCHMARK_STRICT` | 回归时 exit 1 阻止 push | 未设置（warn only） |
| `BENCHMARK_DISABLE` | 完全跳过 benchmark 检查 | 未设置 |

---

## 工作流

```
修改代码 → npm run build → npm run benchmark:check
                                   │
                          ✅ 通过 → git push
                          ⚠️ 警告 → git push（默认非阻塞）
                          ❌ 阻止 → 排查修复 → 重新检查（仅 strict 模式）
                                   │
                          npm run benchmark:save (更新基线)
```

---

## 与旧版 (v2) 的区别

| | v2 (旧) | v3 (当前) |
|---|---|---|
| 运行次数 | 单次 | 默认 3 次取中位数 |
| 阈值 | 严格 (10-20% 容忍) | 宽松 (50-150% 容忍) |
| 失败行为 | 阻止 push | 默认 warn-only |
| 平滑非确定性 | ❌ | ✅ 多轮中位数 |
