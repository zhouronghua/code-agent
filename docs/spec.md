# CodeAgent - 产品规格说明 (Spec)

## 1. 产品概述

CodeAgent 是在 VS Code 源码基础上增量开发的 AI 编码代理。仿照 Cursor Agent 架构，在 VS Code 的 `workbench/contrib` 层添加完整的 agent 子系统，使 VS Code 具备自主编码能力。

## 2. 技术基线

- **起点**: VS Code 源码 (TypeScript + Electron)
- **增量模块**: `src/vs/workbench/contrib/agent/` (新增 Contribution)
- **服务层**: `src/vs/workbench/services/agent/` (新增 Services)
- **精简核心**: `vs-core/` (从 VS Code 提取的最小 API shim)
- **遵循**: VS Code 架构规范 - DI 注入、生命周期、Contribution 注册

## 3. 核心功能

| 功能 | 描述 |
|------|------|
| Agent Loop | ReAct 循环: 推理 -> 工具调用 -> 观察 -> 循环 |
| 多模式 | Agent (自主执行), Ask (只读), Plan (规划) |
| Tool System | 文件读写、终端执行、代码搜索、目录浏览、精确编辑 |
| 多 LLM | OpenAI / Anthropic / Ollama，兼容 DeepSeek |
| 流式输出 | 实时逐 token 流式显示 LLM 推理过程 |
| 并行 Agent | 多任务并发执行，独立上下文隔离 |
| Checkpoint | 变更前自动快照，支持回滚 |
| Context Management | 滑动窗口 + 自动摘要压缩 |

## 4. 技术栈

- TypeScript (编译目标 ES2022)
- esbuild (打包)
- Node.js >= 18 (运行时)
- VS Code API shim layer (精简核心)

## 5. 架构概览

```
User CLI / VS Code Panel
        |
        v
  AgentCore (orchestrator)
  |--- ModeManager (Agent/Ask/Plan)
  |--- Planner (task decomposition)
  |--- ParallelManager (concurrent agents)
  |--- Context (sliding window + summary)
  |--- Checkpoint (file snapshots)
  |--- ToolRegistry
  |      |--- read_file, write_file, edit_file
  |      |--- list_directory, search_text, search_files
  |      |--- run_terminal
  |--- LLMProvider
         |--- OpenAI (+ DeepSeek compatible)
         |--- Anthropic
         |--- Ollama
```

## 6. 支持的 LLM

| Provider | 模型 | 特性 |
|----------|------|------|
| OpenAI | gpt-4o, gpt-4o-mini | Function calling + streaming |
| DeepSeek | deepseek-v4-flash | 兼容 OpenAI API, reasoning_content |
| Anthropic | Claude 4 | tool_use blocks + streaming |
| Ollama | llama3, codellama | 本地部署 |
