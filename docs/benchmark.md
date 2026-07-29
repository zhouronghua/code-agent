# Code-Agent Benchmark Report v2

> **新机制**: 每次 benchmark 都用**最新 build 的 agent** 运行固定测试集，生成**反映最新代码质量**的指标。
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
   ├─ 2. 🧪 运行 benchmarks/suite/  ← 用新 agent 跑测试集
   ├─ 3. 📏 收集指标               ← 从新产生的任务日志提取
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

## 🛡️ 门禁检查阈值

> 以下阈值在 `git push` 前自动检查。任一指标恶化超过容忍度则**阻止推送**。

| 指标 | 方向 | 容忍度 | 说明 |
|------|------|--------|------|
| `successRate` | ↑ 越高越好 | -2% | 任务通过率 |
| `avgDurationSec` | ↓ 越低越好 | +20% | 平均任务耗时 |
| `avgSteps` | ↓ 越低越好 | +15% | 平均步骤数 |
| `avgToolCalls` | ↓ 越低越好 | +15% | 平均工具调用数 |
| `toolExecSuccessRate` | ↑ 越高越好 | -3% | 工具执行成功率 |
| `avgToolCallsPerStep` | ↓ 越低越好 | +10% | 每步平均调用数 |

---

## 工作流

```
修改代码 → npm run build → npm run benchmark:check
                                   │
                          ✅ 通过 → git push
                          ❌ 失败 → 排查修复 → 重新检查
                                   │
                          npm run benchmark:save (更新基线)
```

---

## 与旧版 (v1) 的区别

| | v1 (已废弃) | v2 (当前) |
|---|---|---|
| 数据来源 | ~/.codeagent/tasks/ 历史日志 | 最新 build 运行测试集 |
| 反映代码修改 | ❌ 旧版本产生的日志 | ✅ 新代码运行的结果 |
| 可重复 | ❌ 依赖历史使用记录 | ✅ 固定测试集 |
| 新版首次运行 | 总是通过（数据没变） | 真实反映新代码质量 |
