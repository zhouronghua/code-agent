# CodeAgent - 开发计划

## 里程碑概览

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M0 | 项目基础设施 (类型系统 + DI) | 完成 |
| M1 | LLM Provider 层 | 完成 |
| M2 | Tool 系统 (7 个工具) | 完成 |
| M3 | Agent 核心引擎 | 完成 |
| M4 | UI + VS Code 集成 | 完成 |
| M5 | VS Code 核心精简提取 | 完成 |
| M6 | Plan/Stream/Parallel 功能 | 完成 |

## M0: 项目基础设施

- agentModels.ts - 所有接口、枚举、类型
- agentService.ts - IAgentService 接口 + DI decorator
- VS Code API shim 层 (Event, Lifecycle, URI, Buffer, DI)

## M1: LLM Provider 层

- llmProvider.ts - ILLMProvider 抽象 + 工厂模式
- llmOpenai.ts - OpenAI Chat Completions + function calling + streaming
- llmAnthropic.ts - Anthropic Messages API + tool_use
- llmOllama.ts - Ollama 本地 REST API

## M2: Tool 系统

- agentTools.ts - AgentTool 基类 + ToolRegistry
- 7 个工具实现: read_file, write_file, edit_file, list_directory, search_text, search_files, run_terminal

## M3: Agent 核心引擎

- agent.ts - ReAct 核心循环 + 流式输出支持
- agentContext.ts - 滑动窗口 + 摘要压缩
- agentModes.ts - 模式管理
- agentPlanner.ts - Plan 模式
- agentCheckpoint.ts - 文件快照 + 回滚
- agentPrompts.ts - 系统提示词

## M4: UI + VS Code 集成

- agentViewPane.ts - 侧边栏面板
- agentPanel.ts - Chat UI (消息列表 + 输入框)
- agentActions.ts - 7 个命令注册
- agent.contribution.ts - Workbench 注册入口
- agent.css - VS Code 主题适配样式

## M5: VS Code 核心精简

- 从 ~/work/code/vscode 提取精简 API shim
- base: Event, Lifecycle, URI, Buffer, CancellationToken
- platform: DI, FileService, Config, Workspace
- Node.js 运行时: NodeFileService, NodeSearchService, NodeTerminalService
- esbuild 打包: ~70KB 单文件输出

## M6: Plan/Stream/Parallel

- Plan 模式 CLI 集成 (--mode plan)
- 流式输出支持 (--stream)
- 并行 Agent (--parallel, ParallelAgentManager)
- CLI 命令: /mode, /stream, /parallel

## 依赖图

```
M0 (Types)
 |
 +---> M1 (LLM) ---+
 |                   |
 +---> M2 (Tools) --+--> M3 (Core) --> M4 (UI)
                                   |
                          M5 (VS Code Core) --> M6 (Plan/Stream/Parallel)
```

## 构建和运行

```bash
npm install          # 安装依赖
npm run build        # esbuild 打包
npm run typecheck    # TypeScript 类型检查
npm start            # 运行 CLI (需要 API Key)
```
