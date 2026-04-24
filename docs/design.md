# CodeAgent - 详细技术设计

## 1. 项目结构

```
codeagent/
  src/vs/workbench/
    contrib/agent/                    # Contribution 层
      common/
        agent.ts                      # AgentLoop - ReAct 核心循环
        agentTools.ts                 # Tool 基类 + ToolRegistry
        agentContext.ts               # 上下文管理
        agentModes.ts                 # Agent/Ask/Plan 模式
        agentPlanner.ts               # Plan 模式实现
        agentCheckpoint.ts            # Checkpoint 系统
        agentPrompts.ts               # 系统提示词
        agentParallel.ts              # 并行 Agent 管理器
        tools/
          readFile.ts writeFile.ts editFile.ts
          listDir.ts searchText.ts searchFiles.ts
          runTerminal.ts
      browser/
        agent.contribution.ts         # VS Code 注册入口
        agentViewPane.ts              # 侧边栏面板
        agentPanel.ts                 # Chat UI
        agentActions.ts               # 命令/快捷键
        media/agent.css               # 样式

    services/agent/                   # Service 层
      common/
        agentModels.ts                # 数据模型
        agentService.ts               # IAgentService 接口
      browser/
        agentService.ts               # AgentService 实现
        llmProvider.ts                # LLM 抽象 + 工厂
        llmOpenai.ts llmAnthropic.ts llmOllama.ts

  vs-core/                            # VS Code 精简核心
    base/common/                      # Event, Lifecycle, URI, Buffer
    platform/                         # DI, FileService, Config
    workbench/                        # Search, Terminal, Views
    node-runtime/                     # Node.js 原生实现 + CLI
```

## 2. 核心数据模型

```typescript
enum MessageRole { System, User, Assistant, Tool }
enum AgentMode { Agent, Ask, Plan }

interface IAgentMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: IToolCall[];
  toolCallId?: string;
  reasoningContent?: string;  // DeepSeek 兼容
}

interface IToolCall {
  id: string; name: string;
  arguments: Record<string, unknown>;
}

interface IAgentConfig {
  provider: 'openai' | 'anthropic' | 'ollama';
  model: string; apiKey: string;
  maxSteps: number; maxContextTokens: number;
  temperature: number;
}
```

## 3. Agent 核心循环

```
AgentLoop.run(userMessage):
  1. context.setSystemPrompt(mode_prompt)
  2. context.addMessage(userMessage)
  3. if Plan mode: generate plan, return
  4. while stepCount < maxSteps:
     a. messages = context.getContextWindow()
     b. tools = mode == Ask ? readOnlySchemas : allSchemas
     c. response = llm.complete(messages, tools)
     d. if streaming: stream tokens to UI
     e. context.addMessage(response)
     f. if no tool_calls: break (final answer)
     g. for each toolCall:
          - checkpoint if writing
          - result = tool.execute(args)
          - context.addMessage(result)
     h. stepCount++
```

## 4. Tool 系统

| Tool | 注入服务 | 功能 |
|------|---------|------|
| read_file | IFileService | 读文件，行号标注 |
| write_file | IFileService | 创建/覆盖文件 |
| edit_file | IFileService | 精确字符串替换 |
| list_directory | IFileService | 列目录 (递归) |
| search_text | ISearchService | ripgrep 文本搜索 |
| search_files | ISearchService | glob 文件搜索 |
| run_terminal | ITerminalService | Shell 命令执行 |

## 5. 并行 Agent

ParallelAgentManager 支持并发执行多个独立任务:
- 每个任务创建独立的 AgentLoop + ModeManager
- 共享 ToolRegistry 和 CheckpointManager
- 最大并发数可配置 (默认 4)
- 通过 Promise.allSettled 管理批次执行
- 事件: onDidTaskStart, onDidTaskComplete, onDidAllComplete

## 6. Context 管理策略

- 滑动窗口: 从最新消息向前填充，不超过 maxTokens 的 80%
- 摘要压缩: 超限时将前半消息用 LLM 压缩为 summary
- System Prompt 永远保留在上下文首位

## 7. LLM Provider 设计

```typescript
interface ILLMProvider {
  complete(messages, tools?, temperature?): Promise<IAgentMessage>;
  stream(messages, tools?, temperature?): AsyncIterableIterator<string>;
  countTokens(text: string): number;
}

class LLMProviderFactory {
  static register(name, ctor);
  static create(config): ILLMProvider;
}
```

DeepSeek 兼容: 自动保留和回传 `reasoning_content` 字段。
