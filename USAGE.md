# CodeAgent 使用说明

基于 VS Code 架构的 AI 编码助手 CLI 工具。

## 安装

### 方法一：从 GitHub Releases 安装（推荐）

```bash
# 从 GitHub Release 下载 tgz 包
curl -LO https://github.com/zhouronghua/code-agent/releases/latest/download/code-agent-0.2.4.tgz
npm install -g code-agent-0.2.4.tgz

# 验证安装
code-agent --help
agent-cli --help    # 同一个程序，两个命令名都可以
```

安装后会注册两个全局命令：`code-agent` 和 `agent-cli`。

### 方法二：从 npm 安装

```bash
npm install -g code-agent
```

### 方法三：从源码安装

```bash
git clone https://github.com/zhouronghua/code-agent.git && cd code-agent
npm install
npm run build          # 开发构建
npm run build:release  # 生产构建（minify）
npm link               # 全局注册命令
```

### 方法四：单文件直接运行（无需安装）

只需 `agent-cli.js` 一个文件即可运行，适合快速尝试：

```bash
# 从 GitHub Release 下载单文件
curl -LO https://github.com/zhouronghua/code-agent/releases/latest/download/agent-cli.js
node agent-cli.js --help
```

或者从 tgz 解压：

```bash
tar xzf code-agent-x.y.z.tgz
cp package/build/agent-cli.js ./agent-cli.js

# 直接运行（需要 Node.js >= 18）
node agent-cli.js --help
node agent-cli.js "your task"
```

## 配置

CodeAgent 通过 YAML 配置文件管理 LLM 提供商和参数，**不需要每次手动设置环境变量**。

### 第一步：创建配置文件

复制模板到以下位置之一：

```bash
# 项目级配置（仅当前目录有效）
cp config.template.yaml config.yaml

# 或者全局配置（所有项目共享）
mkdir -p ~/.codeagent
cp config.template.yaml ~/.codeagent/config.yaml
```

### 第二步：填入 API 密钥

编辑 `config.yaml`，填写你的 LLM 提供商信息：

```yaml
active_profile: openai

profiles:
  openai:
    provider: openai
    model: gpt-4o
    api_key: "sk-your-actual-key-here"
    api_base: https://api.openai.com/v1
```

### 配置优先级

配置解析按以下优先级合并（高 -> 低）：

1. CLI 参数（`--profile`、`--mode` 等）
2. 环境变量（`OPENAI_API_KEY`、`LLM_MODEL`、`LLM_PROVIDER`、`LLM_API_BASE`）
3. 项目目录下的 `config.yaml`
4. `~/.codeagent/config.yaml`
5. 内置默认值

即使没有配置文件，设置环境变量也能正常工作：

```bash
export OPENAI_API_KEY=sk-xxx
export LLM_MODEL=gpt-4o
agent-cli "create a hello world"
```

### 多 Profile 支持

可以在一个配置文件中定义多个 profile，通过 `--profile` 切换：

```yaml
profiles:
  openai:
    provider: openai
    model: gpt-4o
    api_key: "sk-xxx"

  local:
    provider: ollama
    model: llama3
    api_base: http://localhost:11434
```

```bash
agent-cli --profile openai "refactor this code"
agent-cli --profile local "explain this function"
```

### 模型路由（Model Routing）

开启后，agent 会在同一个 session 内根据每条 prompt 自动选择并切换模型，
支持第一个 prompt 的自动选择以及后续 prompt 的自动切换。场景由关键词识别：

| 场景 | 触发 | 典型任务 |
|------|------|---------|
| `vision` | 图片/截图/OCR/视觉关键词 | 看图、分析截图 |
| `reasoning` | 重构/调试/架构/性能等复杂关键词 | 重构、debug、架构设计 |
| `fast` | 其余任务 | 简单、快速任务 |

```yaml
model_routing:
  enabled: true
  default: deepseek-v4-flash          # 未命中场景时的兜底模型
  scenarios:
    reasoning: deepseek-v4-pro        # 复杂任务
    vision: deepseek-v4-flash-vision-exp  # 视觉任务
    fast: deepseek-v4-flash           # 简单任务
```

`scenarios` 的取值可以是 `models.json` 里的模型 id，也可以是 `config.yaml` 里定义的
profile 名。存在 `model_routing` 配置段即默认启用（`enabled: false` 可关闭）。
模型切换会保留当前 session 的上下文历史。

```bash
# 无需任何额外参数，agent 会根据任务自动选择模型
agent-cli "重构这个模块的认证逻辑"
agent-cli "分析这张截图的布局问题"
agent-cli "写一个 hello world 脚本"
```

## 使用方法

### 基本用法

```bash
# Agent 模式（默认）：全自动读写文件、执行命令
agent-cli "create a fibonacci function in Python and test it"

# Plan 模式：只生成实施计划不执行
agent-cli --mode plan "add caching to the database layer"

# Ask 模式：只读探索代码库回答问题
agent-cli --mode ask "how does the auth middleware work?"

# 流式输出
agent-cli --stream "explain the project structure"

# 并行任务
agent-cli --parallel "write unit tests for auth" "add API docs"
```

### 交互式 REPL

不带任务参数启动进入交互模式：

```bash
agent-cli
Agent> write a sort function
Agent> /mode plan
Agent> design a caching system
Agent> /skill cpp-forge
Agent> compile the project with warnings
Agent> /stream
Agent> explain this code
Agent> exit
```

REPL 命令：
- `/mode <agent|plan|ask>` -- 切换模式
- `/stream` -- 开关流式输出
- `/skills` -- 列出已加载技能
- `/skill <name>` -- 激活指定技能
- `/parallel "t1" "t2"` -- 并行执行任务
- `exit` / `quit` -- 退出

### 查看信息

```bash
agent-cli --profiles   # 列出所有配置 profile
agent-cli --skills     # 列出已加载的技能
agent-cli --help       # 显示帮助
```

## Skills 支持

CodeAgent 支持 Cursor 兼容的 SKILL.md 技能文件。技能提供特定领域的专业知识，
自动注入到 Agent 的系统提示词中。

### 技能目录

默认扫描以下目录：

```yaml
skills:
  - ~/.cursor/skills
  - ~/.cursor/skills-cursor
  - .cursor/skills
```

### 使用技能

```bash
# 列出可用技能
agent-cli --skills

# 激活特定技能执行任务
agent-cli --use-skill cpp-forge "compile and fix all warnings"
agent-cli --use-skill code-review-excellence "review the latest changes"
```

### 自定义技能

创建目录结构：

```
~/.cursor/skills/my-skill/
  SKILL.md
```

SKILL.md 格式（推荐使用完整的前置元数据，支持自动匹配）：

```markdown
---
name: my-skill
description: Description of what this skill does
whenToUse: Situations the skill applies to (used for self-matching)
trigger:
  - trigger-keyword-1
  - trigger-keyword-2
disable-model-invocation: false
user-invocable: false
---

# My Skill

Detailed instructions for the agent when this skill is active...
```

- `name`：小写 kebab-case（如 `cpp-forge`）
- `description`：一句话说明技能用途和调用时机（必需）
- `whenToUse`：可选的适用场景说明，帮助 Agent 自匹配
- `trigger`：可选的触发关键词列表，命中任务时自动激活并注入完整内容
- `disable-model-invocation` / `user-invocable`：调用权限标记

### 技能封装（Meta-Skill：skills of skills）

CodeAgent 内置了从 `dsh-run2skill` 移植的技能封装逻辑，让 Agent 自己就能
创建、去重和发布规范的 SKILL.md，实现"技能的技能"：

- **规范渲染**：`renderCanonicalSkill` 按统一契约（name/description/whenToUse/trigger/invocation）
  渲染 SKILL.md，非法名称、缺少描述、内容无标题等都会在写入前被拒绝。
- **技能目录**：`skill_catalog` 工具快照所有已加载技能；传入 `query` 时按
  相关性排序（拉丁词 + 中文二元组模糊匹配），提示 `COVERED` / `PARTIAL` / `UNRELATED`。
- **去重召回**：创建前先召回已有技能，避免重复造轮子——`COVERED` 应更新旧技能，
  `PARTIAL` 应合并扩展，`UNRELATED` 才新建。
- **发布**：`create_skill` / `update_skill` 将技能原子写入 `{skills 目录}/{name}/SKILL.md`，
  默认不覆盖已存在技能。

```bash
# 在会话中直接让 Agent 管理技能库
Agent> 把刚才的提交流程保存成一个 skill
Agent> 查一下有没有和"提交代码"相关的技能   # Agent 会调用 skill_catalog
```

## Rules 支持

自动加载 Cursor 兼容的 `.mdc` 规则文件。标记为 `alwaysApply: true` 的规则
会自动注入到每次对话中。

规则目录：

```yaml
rules:
  - ~/.cursor/rules
  - .cursor/rules
```

## MCP (Model Context Protocol) 支持

CodeAgent 支持通过 MCP 协议扩展工具能力。在 `config.yaml` 中配置 MCP 服务器：

```yaml
mcp_servers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /path/to/workspace

  github:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-github"

  custom-api:
    url: http://localhost:3000/mcp
```

每个 MCP 服务器提供额外的工具，agent 可以在对话中调用它们。

## 共享记忆（tdai_agent_mem）支持

CodeAgent 支持接入 [tdai_agent_mem](https://github.com/Tencent/TencentDB-Agent-Memory)
多机/多 Agent 共享记忆中心。开启后：

- **自动召回**：每次任务开始前，按 Memory 分级召回相关记忆注入系统提示词
  - L1（原子事实）`searchAtomic` → `<relevant-memories>`
  - L2（场景索引）`scenario/ls` → Scenario Index
  - L3（用户画像）`core/read` → `<user-persona>`
- **自动捕获**：每次任务结束后，把本轮对话写入 L0（`conversation/add`），
  记忆中心的后台流水线会自动把 L0 蒸馏为 L1 → L2 → L3，实现多机共享
- **记忆工具**：注册 `tdai_memory_search`（L1 搜索）、`tdai_conversation_search`
  （L0 对话搜索）、`tdai_read_file`（读取 L2/L3 文件）、`tdai_memory_write`
  （按 l1/l2/l3 分级写入）

### 配置方式一：config.yaml（推荐）

```yaml
memory:
  enabled: true
  endpoint: http://10.9.114.25:8420   # Memory 内核 / gateway 地址
  api_key: sk-mem-xxx                 # 你的用户 key（sk-mem-...）
  service_id: default                 # 实例 ID（x-tdai-service-id）
  username: zrh                       # 记忆平台上的用户名
  team_id: team-xxx
  agent_id: agt-xxx
  user_id: usr-xxx
  session_id: ""                      # 可选；留空则按工作目录聚合
  recall: true                        # 任务前自动召回（默认 true）
  capture: true                       # 任务后自动捕获 L0（默认 true）
```

### 配置方式二：MCP 配置（~/.codeagent/mcp.json）

用户名与凭据也可以写在 `~/.codeagent/mcp.json` 的 `mcpServers.tdai_agent_mem` 条目：

```json
{
  "mcpServers": {
    "tdai_agent_mem": {
      "type": "streamableHttp",
      "url": "http://10.9.114.25:8420",
      "headers": {
        "Authorization": "Bearer sk-mem-xxx",
        "X-Tdai-Service-Id": "default",
        "X-Tdai-User-Key": "sk-mem-xxx"
      },
      "username": "zrh",
      "teamId": "team-xxx",
      "agentId": "agt-xxx",
      "userId": "usr-xxx"
    }
  }
}
```

记忆服务不可用时所有操作静默降级（fail-open），不会影响主流程。

## 分发

### 通过 GitHub Releases 分发（推荐）

推送 git tag 即可自动触发 GitHub Actions 生成 Release：

```bash
# 1. 更新版本号
npm version patch   # 0.2.0 -> 0.2.1（修复）
# 或 npm version minor  # 0.2.0 -> 0.3.0（新功能）
# 或 npm version major  # 0.2.0 -> 1.0.0（重大变更）

# 2. 推送 tag
git push origin --tags
```

CI 自动完成：构建 -> 打包 tgz -> 创建 GitHub Release -> 发布到 npm。

用户安装：`npm install -g https://github.com/zhouronghua/code-agent/releases/latest/download/code-agent-x.y.z.tgz`

### 通过 npm registry 分发

```bash
npm publish --access public
```

### 单文件分发

最轻量的分发方式，只需 1 个文件 + 1 个配置模板：

```bash
npm run build:release
# 将以下文件发给对方：
#   build/agent-cli.js         (44 KB, 可执行)
#   config.template.yaml       (1.7 KB, 配置模板)

# 对方运行：
cp config.template.yaml config.yaml
# 编辑 config.yaml 填入 API key
node agent-cli.js "your task"
```

## 快速上手（收到安装包后）

```bash
# 1. 安装（从 GitHub Releases 或 npm）
npm install -g code-agent

# 2. 创建配置（全局，只需一次）
mkdir -p ~/.codeagent
code-agent --help   # 查看模板位置
# 从安装包复制模板：
cp $(npm root -g)/code-agent/config.template.yaml ~/.codeagent/config.yaml

# 3. 编辑配置，填入你的 API key
vi ~/.codeagent/config.yaml
# 修改 active_profile 和对应 profile 的 api_key

# 4. 验证
code-agent --profiles    # 查看可用 profile
code-agent --skills      # 查看可用技能

# 5. 开始使用
code-agent "write a hello world in Python"
code-agent --mode plan "design a REST API"
code-agent --mode ask "explain the project structure"
```

## 系统要求

- Node.js >= 18.0.0
- 至少一个 LLM API 密钥（OpenAI / Anthropic / Ollama / 或其他 OpenAI 兼容服务）
