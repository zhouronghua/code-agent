# CodeAgent 代码架构说明

> 基于 VS Code 架构的 AI 编码助手 CLI 工具，支持多 LLM Provider、Cursor 兼容的技能与规则系统。

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 目录结构](#2-目录结构)
- [3. 核心架构](#3-核心架构)
- [4. 数据模型](#4-数据模型)
- [5. 模块详解](#5-模块详解)
- [6. 构建与运行](#6-构建与运行)
- [7. 配置系统](#7-配置系统)

---

## 1. 项目概览

| 项目 | 说明 |
|------|------|
| **名称** | code-agent |
| **版本** | 0.2.0 |
| **语言** | TypeScript (ES2022) |
| **运行时** | Node.js >= 18 |
| **打包工具** | esbuild |
| **入口** | `vs-core/node-runtime/main.ts` → 输出 `build/agent-cli.js` |
| **许可证** | MIT |

### 核心能力

- **Agent 模式**：自主编码，可读写文件、执行命令、搜索代码
- **Ask 模式**：只读模式，仅探索和回答问题
- **Plan 模式**：生成实施计划，确认后执行
- **并行模式**：多任务并发执行
- **流式输出**：实时逐 token 显示 LLM 推理过程
- **Checkpoint**：写文件前自动快照，支持回滚
- **Skills/Rules**：加载 Cursor 兼容的技能和规则文件

---

## 2. 目录结构

```
code-agent/
├── src/                              # 源码（VS Code Contribution 层）
│   └── vs/workbench/
│       ├── contrib/agent/            # Agent Contribution 层
│       │   ├── common/               #   核心逻辑
│       │   │   ├── agent.ts          #   AgentLoop - ReAct 核心循环
│       │   │   ├── agentTools.ts     #   Tool 基类 + ToolRegistry
│       │   │   ├── agentContext.ts   #   上下文管理（滑动窗口 + 压缩）
│       │   │   ├── agentModes.ts     #   模式切换 (Agent/Ask/Plan)
│       │   │   ├── agentPlanner.ts   #   Plan 模式实现
│       │   │   ├── agentCheckpoint.ts #   Checkpoint 快照系统
│       │   │   ├── agentParallel.ts  #   并行 Agent 管理器
│       │   │   ├── agentPrompts.ts   #   系统提示词模板
│       │   │   ├── agentConfig.ts    #   YAML 配置解析
│       │   │   ├── agentSkills.ts    #   Skills/Rules 加载器
│       │   │   └── tools/            #   工具实现（7个）
│       │   │       ├── readFile.ts
│       │   │       ├── writeFile.ts
│       │   │       ├── editFile.ts
│       │   │       ├── listDir.ts
│       │   │       ├── searchText.ts
│       │   │       ├── searchFiles.ts
│       │   │       └── runTerminal.ts
│       │   └── browser/              #   VS Code UI 集成
│       │       ├── agent.contribution.ts
│       │       ├── agentViewPane.ts
│       │       ├── agentPanel.ts
│       │       ├── agentActions.ts
│       │       └── media/agent.css
│       └── services/agent/           # Service 层
│           ├── common/
│           │   ├── agentModels.ts    #   数据模型定义
│           │   └── agentService.ts   #   IAgentService 接口
│           └── browser/
│               ├── agentService.ts   #   AgentService 实现
│               ├── llmProvider.ts    #   LLM 抽象 + 工厂
│               ├── llmOpenai.ts      #   OpenAI Provider
│               ├── llmAnthropic.ts   #   Anthropic Provider
│               └── llmOllama.ts      #   Ollama Provider
│
├── vs-core/                          # VS Code 精简核心（API shim）
│   ├── base/common/                  # 基础工具
│   │   ├── event.ts                 #   事件系统 (Emitter/Event)
│   │   ├── lifecycle.ts             #   生命周期 (Disposable)
│   │   ├── cancellation.ts          #   取消令牌
│   │   ├── uri.ts                   #   URI 封装
│   │   ├── buffer.ts                #   VSBuffer
│   │   ├── codicons.ts              #   图标
│   │   ├── keyCodes.ts              #   键码
│   │   └── ...
│   ├── platform/                     # 平台抽象层
│   │   ├── files/common/files.ts    #   IFileService 接口
│   │   ├── instantiation/common/    #   DI 容器
│   │   ├── configuration/common/    #   配置
│   │   ├── theme/common/            #   主题
│   │   └── ...
│   ├── workbench/                    # Workbench 服务接口
│   │   ├── services/search/common/  #   搜索服务接口
│   │   └── contrib/terminal/browser/#   终端服务接口
│   └── node-runtime/                 # Node.js 运行时实现
│       ├── main.ts                  #   CLI 入口
│       ├── nodeFileService.ts       #   文件服务（fs 实现）
│       ├── nodeSearchService.ts     #   搜索服务（ripgrep 实现）
│       └── nodeTerminalService.ts   #   终端服务（child_process 实现）
│
├── standalone-demo/                  # 单文件无依赖 Demo
│   ├── agent.mjs                    #   完整 Agent 实现（502行）
│   ├── fibonacci.py                 #   测试文件
│   └── package.json
│
├── build/                            # 构建输出
│   ├── agent-cli.js                 #   打包后的 CLI
│   └── config.template.yaml
│
├── docs/                             # 文档
│   ├── design.md                    #   详细技术设计
│   ├── spec.md                      #   产品规格说明
│   └── dev-plan.md                  #   开发计划
│
├── .cursor/rules/                    # Cursor 规则
│   └── durable-request.mdc          #   alwaysApply 规则
│
├── config.template.yaml              # 配置模板
├── package.json
├── tsconfig.json
└── build.mjs                         # esbuild 构建脚本
```

---

## 3. 核心架构

### 3.1 分层设计

```
┌──────────────────────────────────────────────────┐
│                CLI / VS Code Panel                │
├──────────────────────────────────────────────────┤
│               AgentLoop (orchestrator)            │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ModeManager│ │ Planner  │ │ ParallelManager  │  │
│  └──────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Context  │ │Checkpoint│ │  ToolRegistry    │  │
│  └──────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────────────────────────────────────┐    │
│  │           LLMProvider 层                  │    │
│  │   OpenAI / Anthropic / Ollama             │    │
│  └──────────────────────────────────────────┘    │
├──────────────────────────────────────────────────┤
│            vs-core (Node.js Runtime)              │
│   FileService / SearchService / TerminalService   │
└──────────────────────────────────────────────────┘
```

### 3.2 核心调用流程

```
main.ts (CLI 入口)
  │
  ├─ parseArgs() → CLI 参数解析
  ├─ loadConfig(profile) → 加载 YAML 配置 + 环境变量
  ├─ SkillsLoader → 加载 skills + rules
  │
  ├─ createServices() → 创建各服务实例
  │   ├─ LLMProviderFactory.create(config) → ILLMProvider
  │   ├─ NodeFileService → IFileService
  │   ├─ NodeSearchService → ISearchService
  │   ├─ NodeTerminalService → ITerminalService
  │   └─ ToolRegistry → 注册 7 个工具
  │
  └─ AgentLoop.run(task)
       │
       ├─ 1. context.setSystemPrompt(mode_prompt + skills/rules)
       ├─ 2. context.addMessage(userMessage)
       ├─ 3. if Plan mode: planner.createPlan() → 返回计划
       ├─ 4. while stepCount < maxSteps:
       │     a. context.getContextWindow() → 滑动窗口
       │     b. tools = readOnlySchemas (Ask) | allSchemas (Agent)
       │     c. llm.complete(messages, tools) → response
       │     d. context.addMessage(response)
       │     e. if no toolCalls → break (最终回答)
       │     f. for each toolCall:
       │          - checkpointManager.snapshotFile() (写操作前)
       │          - tool.execute(args) → result
       │          - context.addMessage(resultMessage)
       │     g. stepCount++
       └─ 5. dispose() → 清理资源
```

---

## 4. 数据模型

核心类型定义在 `src/vs/workbench/services/agent/common/agentModels.ts`：

```typescript
// 消息角色
enum MessageRole { System = 'system', User = 'user', Assistant = 'assistant', Tool = 'tool' }

// Agent 模式
enum AgentMode { Agent = 'agent', Ask = 'ask', Plan = 'plan' }

// 步骤状态
enum StepStatus { Pending = 'pending', Running = 'running', Done = 'done', Failed = 'failed' }

// 核心消息
interface IAgentMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: IToolCall[];      // 函数调用
  toolCallId?: string;          // 工具响应关联
  timestamp: number;
  reasoningContent?: string;    // DeepSeek 推理内容
}

// 工具调用
interface IToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// Agent 配置
interface IAgentConfig {
  provider: 'openai' | 'anthropic' | 'ollama';
  model: string;
  apiKey: string;
  apiBase?: string;
  maxSteps: number;             // 默认 25
  maxContextTokens: number;     // 默认 128000
  temperature: number;          // 默认 0
  stepTimeout: number;          // 默认 60000ms
  taskTimeout: number;          // 默认 600000ms
}
```

---

## 5. 模块详解

### 5.1 入口模块 (`vs-core/node-runtime/main.ts`)

TypeScript 入口，负责：

- **参数解析**：`--mode`, `--stream`, `--parallel`, `--profile`, `--profiles`, `--skills`, `--use-skill`
- **配置加载**：CLI 参数 > 环境变量 > `config.yaml` > `~/.codeagent/config.yaml`
- **服务创建**：实例化 LLM Provider、文件服务、搜索服务、终端服务、工具注册
- **Agent 循环**：单次任务或交互式 REPL
- **技能注入**：`buildSkillsContext()` 将 rules + skills 拼入 system prompt
- **REPL 命令**：`/mode`, `/stream`, `/skills`, `/skill <name>`, `/parallel`, `exit`

### 5.2 Agent 核心 (`agent.ts` - `AgentLoop`)

ReAct（Reasoning + Acting）循环的实现：

```
AgentLoop.run() → _runAgentLoop()
  │
  ├─ 每次循环调用 llm.complete(messages, tools)
  ├─ 解析响应中的 toolCalls
  ├─ 依次执行每个工具（写操作前创建 checkpoint）
  ├─ 将工具结果放回上下文
  ├─ 直到无 toolCalls 或达到 maxSteps
  └─ 触发事件：onDidReceiveMessage / onDidStreamToken / onDidComplete / onDidError
```

关键特性：
- **流式输出**：通过 `onDidStreamToken` 逐 token 推送
- **Checkpoint 机制**：写文件操作前自动快照
- **超时控制**：每个工具执行有 `stepTimeout`，支持 `Promise.race`

### 5.3 上下文管理 (`agentContext.ts` - `AgentContext`)

- **滑动窗口**：从最新消息向前填充，不超过 `maxTokens * 0.8`
- **自动压缩**：超限时将前半消息用 LLM 压缩为摘要
- **System Prompt 优先**：始终保留在上下文首位

### 5.4 LLM Provider 层

抽象接口 + 工厂模式：

```typescript
interface ILLMProvider {
  complete(messages, tools?, temperature?): Promise<IAgentMessage>;
  stream(messages, tools?, temperature?): AsyncIterableIterator<string>;
  countTokens(text: string): number;
}

class LLMProviderFactory {
  static register(name, ctor);   // provider 注册
  static create(config);         // 按配置创建实例
}
```

| Provider | 注册名 | API 端点 | 特性 |
|----------|--------|----------|------|
| `OpenAIProvider` | `openai` | `/v1/chat/completions` | Function calling + streaming + reasoning_content (DeepSeek 兼容) |
| `AnthropicProvider` | `anthropic` | `/v1/messages` | tool_use blocks + streaming |
| `OllamaProvider` | `ollama` | `/api/chat` | 本地模型 + tool 支持 |

### 5.5 工具系统 (`agentTools.ts`)

7 个工具，继承自 `AgentTool` 基类：

| 工具 | 名称 | 注入服务 | 说明 |
|------|------|---------|------|
| `ReadFileTool` | `read_file` | IFileService | 读文件，支持 offset/limit，带行号输出 |
| `WriteFileTool` | `write_file` | IFileService | 创建/覆盖文件，自动创建目录 |
| `EditFileTool` | `edit_file` | IFileService | 精确字符串替换，支持 replace_all |
| `ListDirectoryTool` | `list_directory` | IFileService | 列目录，支持递归和 max_depth |
| `SearchTextTool` | `search_text` | ISearchService | ripgrep 文本搜索，支持 regex + glob |
| `SearchFilesTool` | `search_files` | ISearchService | glob 文件搜索 |
| `RunTerminalTool` | `run_terminal` | ITerminalService | Shell 命令执行，支持 cwd 和 timeout |

Ask 模式下仅暴露只读工具（`read_file`, `list_directory`, `search_text`, `search_files`）。

### 5.6 Plan 模式 (`agentPlanner.ts` - `AgentPlanner`)

- 使用 LLM 生成 JSON 格式的结构化实施计划
- 计划包含任务描述和步骤列表（每步有工具名和参数）
- Plan 模式生成计划后不执行，询问用户确认后切换到 Agent 模式执行

### 5.7 并行 Agent (`agentParallel.ts` - `ParallelAgentManager`)

- 支持多任务并发执行（默认最大 4 个）
- 每个任务创建独立的 `AgentLoop` + `ModeManager`
- 共享 `ToolRegistry` 和 `CheckpointManager`
- 按批次执行（`Promise.allSettled`）
- 事件：`onDidTaskStart`, `onDidTaskComplete`, `onDidAllComplete`

### 5.8 Skills/Rules 系统 (`agentSkills.ts` - `SkillsLoader`)

- **Skills**：Cursor 兼容的 `SKILL.md` 文件（带 frontmatter），通过 `--use-skill` 激活
- **Rules**：Cursor 兼容的 `.mdc` 文件，`alwaysApply: true` 的规则自动注入到每次对话
- **扫描目录**：在 `config.yaml` 中配置（默认 `~/.cursor/skills`, `.cursor/skills`）

### 5.9 Checkpoint 系统 (`agentCheckpoint.ts` - `AgentCheckpointManager`)

- `createCheckpoint(description)` → 创建检查点 ID
- `snapshotFile(checkpointId, filePath)` → 快照文件内容
- `restore(checkpointId)` → 恢复所有快照文件
- `listCheckpoints()` → 列举所有检查点

---

## 6. 构建与运行

### 6.1 开发构建

```bash
npm install          # 安装依赖
npm run build        # esbuild 打包 (开发模式)
npm run typecheck    # TypeScript 类型检查
npm run build:release # 生产构建 (minify)
```

### 6.2 运行

```bash
# CLI 单次任务
node build/agent-cli.js "你的任务"

# 指定模式
node build/agent-cli.js --mode plan "设计一个缓存系统"
node build/agent-cli.js --mode ask "这段代码做了什么？"

# 流式输出
node build/agent-cli.js --stream "解释项目结构"

# 并行任务
node build/agent-cli.js --parallel "任务1" "任务2"

# 指定 Profile
node build/agent-cli.js --profile kimi-k2.5 "你的任务"

# 交互式 REPL（不带参数）
node build/agent-cli.js

# 查看可用 Profile / Skills
node build/agent-cli.js --profiles
node build/agent-cli.js --skills
```

### 6.3 全局安装

```bash
npm run build && npm link   # 全局注册 agent-cli 命令
# 或
npm run pack                # 打包为 .tgz 分发给团队
npm install -g codeagent-0.2.0.tgz
```

### 6.4 无依赖 Demo

```bash
cd standalone-demo
MOCK_LLM=1 node agent.mjs   # Mock 模式，无需 API Key
```

---

## 7. 配置系统

配置定义在 `config.template.yaml`，支持多 Profile。

### 配置优先级（高 → 低）

1. CLI 参数（`--profile`, `--mode` 等）
2. 环境变量（`OPENAI_API_KEY`, `LLM_MODEL`, `LLM_PROVIDER`, `LLM_API_BASE`, `AGENT_PROFILE`）
3. 项目目录 `./config.yaml`
4. 全局配置 `~/.codeagent/config.yaml`
5. 内置默认值

### 配置结构

```yaml
active_profile: openai        # 当前激活的 Profile

profiles:
  openai:                     # Profile 名称
    provider: openai          # provider 类型: openai | anthropic | ollama
    model: gpt-4o            # 模型名称
    api_key: "sk-xxx"        # API 密钥
    api_base: https://api.openai.com/v1  # API 地址（可选）

agent:                        # Agent 参数
  max_steps: 25
  max_context_tokens: 128000
  temperature: 0
  step_timeout: 60000
  task_timeout: 600000

skills:                       # Skills 扫描目录
  - ~/.cursor/skills
  - .cursor/skills

rules:                        # Rules 扫描目录
  - ~/.cursor/rules
  - .cursor/rules
```

### 示例 Provider / 模型配置

| Profile 名 | Provider | 模型 |
|-----------|----------|------|
| `openai` | openai | `gpt-4o` |
| `deepseek` | openai | `deepseek-chat` |
| `anthropic` | anthropic | `claude-sonnet-4-20250514` |
| `ollama` | ollama | `llama3` |

通过 OpenAI 兼容 API，可以接入任何支持 `/v1/chat/completions` 的模型服务。

---

> **文档生成时间**: 2026-04-24  
> **代码版本**: 0.2.4
