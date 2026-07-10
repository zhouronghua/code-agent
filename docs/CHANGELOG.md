# CodeAgent 代码仓演进历史

> **当前版本**: v0.3.17 | **代码规模**: ~3,900 行 TypeScript 核心代码 + ~500 行独立 Demo | **构建产物**: ~70KB 单文件
>
> 从 2026-04-24 首次提交到 2026-07-10 最新版本，共 **70+ 次提交**，涵盖 **10 个阶段**的持续迭代。

---

## 目录

1. [项目概览](#1-项目概览)
2. [阶段一：基础架构搭建 (2026-04-24)](#2-阶段一基础架构搭建)
3. [阶段二：配置与文档体系 (2026-04-24)](#3-阶段二配置与文档体系)
4. [阶段三：稳定性打磨 v0.2.1~v0.2.4 (2026-04-24)](#4-阶段三稳定性打磨)
5. [阶段四：正式发布与 CI/CD (2026-04-24~27)](#5-阶段四正式发布与-cicd)
6. [阶段五：Thinking 模式支持 v0.2.5~v0.2.16 (2026-04-27~28)](#6-阶段五thinking-模式支持)
7. [阶段六：会话系统与上下文增强 (2026-06-03)](#7-阶段六会话系统与上下文增强)
8. [阶段七：智能推理增强 v0.3.4 (2026-07-01)](#8-阶段七智能推理增强)
9. [阶段八：交互体验升级 (2026-07-01~02)](#9-阶段八交互体验升级)
10. [阶段九：执行追踪与异步工具 (2026-07-02~03)](#10-阶段九执行追踪与异步工具)
11. [阶段十：模型配置现代化 (2026-07-07~10)](#11-阶段十模型配置现代化)
12. [当前功能全景图](#当前功能全景图)
13. [技术架构总览](#技术架构总览)
14. [代码统计](#代码统计)

---

## 1. 项目概览

**CodeAgent** 是一个基于 VS Code 架构的 AI 编码代理 CLI 工具，仿照 Cursor Agent 设计，支持多 LLM Provider、Cursor 兼容技能/规则系统、MCP 协议扩展，并可通过 npm / GitHub Releases / Docker 多种方式分发。

| 属性 | 说明 |
|------|------|
| **语言** | TypeScript (ES2022) |
| **运行时** | Node.js >= 18 |
| **打包工具** | esbuild (单文件打包) |
| **LLM 支持** | OpenAI、Anthropic (Claude)、Ollama、DeepSeek、任意 OpenAI 兼容 API |
| **分发方式** | npm、GitHub Releases (.tgz)、Docker、单文件直接运行 |
| **构建产物** | ~70KB minified，零运行时依赖 |

---

## 2. 阶段一：基础架构搭建

> **时间**: 2026-04-24 | **关键提交**: `d35b909` → `5704ff0`

### 实现内容

- **init**: 仓库初始化，创建 `.cursor/rules/durable-request.mdc` 以及 VS Code Contribution 层基础结构 (`agent.contribution.ts`, `agentActions.ts`)
- **CodeAgent 核心**: 实现了基于 ReAct 循环的完整 Agent 引擎，包括：
  - **Agent Loop**: 推理 → 工具调用 → 观察 → 循环
  - **三种模式**: Agent (自主执行) / Ask (只读) / Plan (规划)
  - **流式输出**: 实时逐 token 显示 LLM 推理过程
  - **并行 Agent**: 多任务并发执行，独立上下文隔离
  - **Tool System**: 文件读写 (`readFile`, `writeFile`, `editFile`)、终端执行 (`runTerminal`)、代码搜索 (`searchText`, `searchFiles`)、目录浏览 (`listDir`)
- **LLM Provider 层**: OpenAI (含 DeepSeek 兼容)、Anthropic (Claude)、Ollama 三大 Provider
- **Checkpoint 系统**: 写文件前自动快照，支持回滚
- **Context Management**: 滑动窗口 + 自动摘要压缩
- **VS Code 精简核心** (`vs-core/`): 事件系统、生命周期、URI、DI 容器等 API Shim
- **Node.js 运行时**: 文件服务 (`fs`)、搜索服务 (`ripgrep`)、终端服务 (`child_process`)

### 架构设计

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
  |--- ToolRegistry (7 tools)
  |--- LLMProvider (OpenAI/Anthropic/Ollama)
```

---

## 3. 阶段二：配置与文档体系

> **时间**: 2026-04-24 | **关键提交**: `697338c` → `afaf156`

### 实现内容

- **配置系统** (`agentConfig.ts`, 378 行): YAML 格式多 Profile 配置管理，支持项目级 (`./config.yaml`) 和全局 (`~/.codeagent/config.yaml`) 双层配置，四级优先级 (CLI > 环境变量 > 项目配置 > 全局配置)
- **Skills 系统** (`agentSkills.ts`, 245 行): Cursor 兼容的 SKILL.md 技能加载器，扫描 `~/.cursor/skills`、`.cursor/skills` 等目录，自动注入 Agent 系统提示词
- **Rules 系统**: `.mdc` 规则文件加载，`alwaysApply: true` 规则自动注入每次对话
- **分发打包** (`build.mjs`): esbuild 单文件打包脚本，支持开发/生产构建
- **包命名与发布**: 包名 `code-agent`，npm publish metadata 配置，`files` 白名单
- **文档体系**:
  - `USAGE.md` (342 行): 安装、配置、使用、Skills/Rules/MCP 完整指南
  - `CODE_ARCHITECTURE.md` (461 行): 分层架构、模块详解、构建运行说明
  - `README.md`: 项目概览与快速上手
- **独立 Demo** (`standalone-demo/agent.mjs`): 502 行单文件零依赖 Agent 实现，支持 `MOCK_LLM=1` 模式

---

## 4. 阶段三：稳定性打磨

> **时间**: 2026-04-24 | **版本**: v0.2.1 → v0.2.4 | **关键提交**: `c6a8fe9` → `908e461`

### 实现内容

- **Temperature 兼容修复**: 修复与多种 Provider 的 temperature 参数兼容性，支持运行时 Profile 切换
- **鲁棒 Temperature 处理** (`llmOpenai.ts`): 按 Profile 独立配置 temperature + 400 错误自动重试
- **YAML 解析增强** (`agentConfig.ts`): 改进 YAML 注释解析，增强配置诊断能力
- **版本管理**: 添加 `--version` flag，修复 AGENT_VERSION 常量同步
- **空工具结果修复**: 修复空 tool result 导致 API 返回 400 的问题

---

## 5. 阶段四：正式发布与 CI/CD

> **时间**: 2026-04-24 | **版本**: v0.2.4 | **关键提交**: `a6e6a88` → `d07b41e`

### 实现内容

- **Initial Release**: 项目正式发布里程碑
- **MCP 协议支持**: Model Context Protocol 服务器配置支持（stdio 和 HTTP 两种类型），Agent 可调用 MCP 提供的额外工具
- **GitHub Actions CI/CD**:
  - `ci.yml`: 构建 + 类型检查自动化
  - `release.yml`: Tag 触发自动构建 → 打包 .tgz → 创建 GitHub Release → npm publish
- **JFrog Artifactory 分发**: 内部制品仓库分发指南

---

## 6. 阶段五：Thinking 模式支持

> **时间**: 2026-04-27~28 | **版本**: v0.2.5 → v0.2.16 | **关键提交**: `a77a902` → `0c87d9c`

### 实现内容

这是项目迭代最密集的阶段（**20+ 次提交**），解决 DeepSeek reasoning 模型的兼容性难题：

| 提交 | 说明 |
|------|------|
| `a77a902` | 移除步数限制，修复 `reasoning_content` 处理 |
| `18ae838` | 通过 esbuild `define` 自动注入 package.json 版本号 |
| `dd8a10e` | 修复 reasoning_content 在 continue 时的错误及步数限制处理 |
| `de60a48` | 修复工具超时，改进 reasoning_content 处理逻辑 |
| `169aa67` | **关键修复**: 修复 thinking 模式下的孤儿 tool messages |
| `ec57db1` | 简化 thinking 模式过滤器：保留所有 tool messages |
| `4bf4323` | **关键修复**: 确保 thinking 模式下消息序列完整性 |
| `4fb90ee` | **新增**: 自动重试临时 API 错误 (transient errors) |
| `29c3845` | 修复客户端错误不重试，thinking 模型禁用 streaming |
| `aa1a127` | 修复上下文压缩后的孤儿 tool messages |
| `d259cf8` | 确保 thinking 模式下所有 assistant messages 均含 reasoning_content |
| `0c87d9c` | 过滤 thinking 模式下无 reasoning_content 的 assistant messages |
| `d6277e2` | **新增**: 将当前工作目录注入系统提示词 |
| `06fd30f` | 重构 llmOpenai.ts (242 行变更)，大幅改进 reasoning_content 处理 |

### 核心难点

DeepSeek 等推理模型返回 `reasoning_content` 字段，与标准 OpenAI API 存在差异：
- 消息序列中 tool message 与 assistant message 的映射关系需要严格保持
- Streaming 模式下 reasoning_content 的拼接与分发
- 上下文压缩后消息序列完整性的恢复
- 临时错误的智能重试（429/5xx 重试，4xx 不重试）

---

## 7. 阶段六：会话系统与上下文增强

> **时间**: 2026-06-03 | **关键提交**: `a6f4165` → `cc86d1d`

### 实现内容

- **会话管理系统** (`agentSessions.ts`, 233 行新文件):
  - 会话持久化：保存/恢复完整对话历史
  - 会话列表：查看所有历史会话
  - 会话删除：清理不需要的会话
  - 自动保存模式：`/auto-save` 开关
  - 会话恢复：`/resume [session-id]` 恢复之前对话
  - 多会话共存：支持同时维护多个独立会话
- **上下文与工具增强** (`agentContext.ts`, 97 行变更):
  - 改进滑动窗口算法
  - 增强上下文压缩策略
  - Checkpoint 系统增强 (文件比较功能)
- **并行 Agent 增强**: 任务分发与结果聚合优化
- **runTerminal 工具增强**: 支持超时控制、输出截断、exit code 检查
- **searchText 工具增强**: 支持 regex 搜索
- **综合测试框架** (`test_harness.mjs`, 213 行): 涵盖多场景的自动化测试

---

## 8. 阶段七：智能推理增强

> **时间**: 2026-07-01 | **版本**: v0.3.4 | **关键提交**: `5cd7095`

### 实现内容 (107 行新增)

- **自我验证机制** (`MAX_VERIFICATION_ROUNDS`): Agent 完成回答后自动注入验证提示词，确保充分验证工作成果，防止提前终止。最多 2 轮验证后接受结论。
- **复杂任务检测** (`COMPLEX_TASK_KEYWORDS`): 识别包含 "refactor"、"重构"、"migrate"、"architecture"、"性能" 等关键词的复杂任务，自动触发深度思考模式，注入额外系统提示词。
- **推理增强提示词** (35 行新增): 针对复杂任务的专门系统提示词模板，引导 Agent 执行更深入的分解与推理。
- **OpenAI Provider 推理兼容** (15 行变更): 适配 OpenAI o-series 推理模型的 reasoning 参数。

---

## 9. 阶段八：交互体验升级

> **时间**: 2026-07-01~02 | **关键提交**: `042077e` → `3df7151`

### 实现内容

- **`/btw` 中途干预命令** (194 行新增 CLI 逻辑):
  - 在任务执行过程中输入 `/btw` 插入额外指令
  - Agent 暂停当前推理，响应新指令后继续
  - 支持取消当前操作 (`/btw cancel`)
- **优雅 Ctrl+C 退出**: 信号处理改进，支持安全中断
- **Sleep 进度指示**: 长任务等待时显示进度动画
- **REPL Tab 自动补全** (175 行新增):
  - 斜杠命令补全: `/resume`、`/mode`、`/profile`、`/skill`、`/btw` 等
  - 动态补全: 会话 ID、Profile 名称、Skill 名称
- **构建修复**: 修复 `package-lock.json` 问题，确保 tag 触发的 CI 构建成功

---

## 10. 阶段九：执行追踪与异步工具

> **时间**: 2026-07-02~03 | **关键提交**: `1998301` → `b1c4901`

### 实现内容

- **全局规则预加载** (`agentSkills.ts`, 50 行变更):
  - 任务启动时预加载所有全局规则内容
  - 预加载所有 Skills 标题用于自动匹配
  - 改进规则/Skills 与任务的匹配逻辑
- **Plan 模式自动执行** (`agent.ts`, 50 行变更):
  - 移除 Plan 模式后的交互式确认提示
  - Plan 生成后自动进入执行阶段
  - 精简 CLI 交互流程
- **任务执行追踪** (`agentTaskLog.ts`, 239 行新文件):
  - 完整的每步执行记录：步骤号、时间戳、推理内容、工具调用、工具结果
  - 任务日志持久化 (`/task-logs` 命令查看)
  - Docker 支持: `Dockerfile` (17 行)，基于 node:18-alpine
  - 任务日志管理器: 文件系统存储、查询、清理
- **Poll 工具** (`tools/poll.ts`, 210 行新文件):
  - 指数退避轮询机制
  - 支持 `success_pattern` 正则匹配成功条件
  - 可配置 `max_attempts`、`initial_delay`、`max_delay`
  - 用于等待异步任务完成 (CI pipeline、容器启动、健康检查等)

---

## 11. 阶段十：模型配置现代化

> **时间**: 2026-07-07~10 | **版本**: v0.3.16 → v0.3.17 | **关键提交**: `b6e57a1` → `d513dc5`

### 实现内容

- **验证轮次调整** (v0.3.15→v0.3.16):
  - 尝试将 `MAX_VERIFICATION_ROUNDS` 从 2 提升到 100
  - 发现 token 消耗过大后回滚到 2
- **推理内容完整展示** (`e5a24c6`):
  - 实时输出中显示完整 `reasoning_content`
  - Standalone Demo 新增 `thinking` 参数支持
- **models.json 支持** (`717d859`, 149 行变更):
  - 兼容 CodeBuddy 的 `models.json` 模型定义格式
  - 从 config.yaml 移除重复的 profile 定义
  - 支持 `supportsReasoning`、`supportsToolCall`、`supportsImages` 等模型能力声明
  - `thinking` 配置 (enabled/disabled)
  - 全局 (`~/.codeagent/models.json`) 和项目级 (`./models.json`) 双层查找
- **默认模型优化** (`f101a12` → `742cb10`):
  - 默认使用 `deepseek-v4-pro`
  - 自动从 models.json 选取模型
  - `active_profile` 未匹配时 fallback 到第一个模型
- **异步工具执行** (`d513dc5`, v0.3.17):
  - 工具执行改为异步模式
  - `/btw cancel` 支持异步任务取消
  - Poll 工具异步增强 (支持取消轮询)
  - 所有工具适配异步执行模式

---

## 当前功能全景图

### 核心 Agent 能力

| 功能 | 说明 |
|------|------|
| **Agent 模式** | 全自主编码：读写文件、执行命令、搜索代码、精确编辑 |
| **Ask 模式** | 只读模式：仅探索代码库、回答问题，不修改文件 |
| **Plan 模式** | 生成实施计划后自动执行，无需人工确认 |
| **并行模式** | 多任务并发执行，独立上下文隔离 |
| **流式输出** | 实时逐 token 显示 LLM 推理过程及 reasoning_content |
| **REPL 交互** | 交互式命令行，Tab 补全，/btw 中途干预 |

### 工具系统 (8 个)

| 工具 | 功能 |
|------|------|
| `readFile` | 读取文件内容，支持偏移量和行数限制 |
| `writeFile` | 创建或覆盖文件 |
| `editFile` | 精确字符串替换编辑 |
| `list_directory` | 浏览目录结构 |
| `search_text` | 正则搜索代码 |
| `search_files` | Glob 模式查找文件 |
| `run_terminal` | 执行 Shell 命令 |
| `poll` | 指数退避轮询，等待异步任务完成 |

### LLM 支持

| Provider | 模型示例 | 特性 |
|----------|---------|------|
| OpenAI | gpt-4o, gpt-4o-mini | Function calling + Streaming |
| DeepSeek (兼容) | deepseek-v4-pro, deepseek-v4-flash | reasoning_content, thinking 模式 |
| Anthropic | Claude 4 | tool_use blocks + Streaming |
| Ollama | llama3, codellama | 本地部署，无需 API key |

### 智能增强

- **自我验证**: 完成回答后自动验证，确保结果正确
- **复杂任务检测**: 识别重构/迁移/优化等复杂任务，自动启用深度思考
- **推理内容展示**: 完整展示 LLM 推理过程 (reasoning_content)
- **自动重试**: 临时 API 错误 (429/5xx) 智能重试，4xx 错误不重试

### 会话与持久化

- 会话保存/恢复/删除
- 自动保存模式
- 任务执行追踪日志
- 每步推理+工具调用完整记录

### 配置与扩展

- **models.json**: CodeBuddy 兼容的模型定义
- **config.yaml**: YAML 多 Profile 配置
- **Skills**: Cursor 兼容 SKILL.md
- **Rules**: `.mdc` 规则文件自动加载
- **MCP 协议**: stdio / HTTP MCP 服务器扩展

### 分发与运维

- npm 发布 (含 GitHub Actions CI/CD)
- GitHub Releases (.tgz 自动构建)
- Docker 镜像 (node:18-alpine)
- 单文件分发 (~70KB，零依赖)
- JFrog Artifactory 内部分发

---

## 技术架构总览

```
┌──────────────────────────────────────────────────────┐
│                 CLI / VS Code Panel                   │
├──────────────────────────────────────────────────────┤
│               AgentLoop (ReAct 引擎)                  │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ModeManager│ │ Planner  │ │ ParallelManager    │   │
│  └──────────┘ └──────────┘ └────────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ Context  │ │Checkpoint│ │  ToolRegistry (8)  │   │
│  └──────────┘ └──────────┘ └────────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │
│  │ Sessions │ │ TaskLog  │ │  Skills / Rules    │   │
│  └──────────┘ └──────────┘ └────────────────────┘   │
│  ┌──────────────────────────────────────────────┐    │
│  │           LLMProvider 层                      │    │
│  │   OpenAI / Anthropic / Ollama / DeepSeek      │    │
│  └──────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────┤
│              vs-core (Node.js Runtime)                │
│    FileService / SearchService / TerminalService      │
└──────────────────────────────────────────────────────┘
```

**源文件分布** (共 3,863 行 TypeScript 核心代码):

| 模块 | 文件 | 行数 |
|------|------|------|
| Agent 主循环 | `agent.ts` | 759 |
| CLI 入口 | `main.ts` | 1,137 |
| 配置管理 | `agentConfig.ts` | 378 |
| Skills 加载 | `agentSkills.ts` | 245 |
| 任务日志 | `agentTaskLog.ts` | 239 |
| 会话管理 | `agentSessions.ts` | 233 |
| 并行管理 | `agentParallel.ts` | 192 |
| 上下文管理 | `agentContext.ts` | 181 |
| Plan 模式 | `agentPlanner.ts` | 166 |
| 系统提示词 | `agentPrompts.ts` | 129 |
| Checkpoint | `agentCheckpoint.ts` | 100 |
| 工具注册 | `agentTools.ts` | 63 |
| 模式管理 | `agentModes.ts` | 41 |

---

## 代码统计

| 指标 | 数值 |
|------|------|
| 总提交数 | 70+ |
| 版本数 | v0.1 → v0.3.17 (核心 20 个正式版本) |
| 源文件数 | 31 个 TypeScript 文件 |
| 核心代码行数 | ~3,900 行 |
| 独立 Demo | 502 行 (standalone-demo/agent.mjs) |
| 构建产物大小 | ~70 KB (minified 单文件) |
| 文档覆盖 | README + USAGE + CODE_ARCHITECTURE + DESIGN + SPEC |
| 工具数量 | 8 个 (read/write/edit/list/search_text/search_files/terminal/poll) |
| LLM Provider | 4 种 (OpenAI / Anthropic / Ollama / DeepSeek 兼容) |
| 分发方式 | npm + GitHub Releases + Docker + 单文件 |

---

> 📅 最后更新: 2026-07-10 | v0.3.17
