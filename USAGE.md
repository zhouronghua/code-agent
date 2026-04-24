# CodeAgent 使用说明

基于 VS Code 架构的 AI 编码助手 CLI 工具。

## 安装

### 方法一：从 npm 安装

```bash
npm install -g code-agent

# 验证安装
code-agent --help
agent-cli --help    # 同一个程序，两个命令名都可以
```

安装后会注册两个全局命令：`code-agent` 和 `agent-cli`。

### 方法二：从 tgz 包安装

```bash
# 下载 tgz 包（从你的 Artifactory / release 页面等）
npm install -g code-agent-x.y.z.tgz
```

### 方法三：从源码安装

```bash
git clone <your-repo-url> && cd code-agent
npm install
npm run build          # 开发构建
npm run build:release  # 生产构建（minify）
npm link               # 全局注册命令
```

### 方法四：单文件直接运行（无需安装）

只需 `agent-cli.js` 一个文件即可运行，适合快速尝试：

```bash
# 从 tgz 解压
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

SKILL.md 格式：

```markdown
---
name: my-skill
description: Description of what this skill does
---

# My Skill

Detailed instructions for the agent when this skill is active...
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

## 分发

### 通过 Artifactory / 私有仓库分发

发布新版本到 JFrog Artifactory 或其他制品库：

```bash
# 1. 构建 release 版本并生成 tgz 包
npm run pack
# 生成: code-agent-x.y.z.tgz

# 2. 上传到 Artifactory（替换为你的实际地址和凭证）
curl -u<USER>:<API_KEY> \
  -T code-agent-x.y.z.tgz \
  "http://your-artifactory.example.com/artifactory/your-repo/code-agent/code-agent-x.y.z.tgz"
```

同事安装方式见上方 "安装" 章节。

**版本更新流程：**

```bash
# 修改代码后...
# 1. 更新版本号
npm version patch   # 0.2.0 -> 0.2.1（修复）
# 或 npm version minor  # 0.2.0 -> 0.3.0（新功能）
# 或 npm version major  # 0.2.0 -> 1.0.0（重大变更）

# 2. 重新打包上传
npm run pack
curl -u<USER>:<KEY> -T code-agent-*.tgz \
  "http://your-artifactory.example.com/artifactory/your-repo/code-agent/"
```

### 通过 npm registry 分发

```bash
# 发布到内网 registry
npm publish

# 发布到公共 npmjs.org
npm publish --registry https://registry.npmjs.org
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
# 1. 安装
npm install -g code-agent-x.y.z.tgz

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
