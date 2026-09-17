---
description: code-agent 仓库默认规则（提交前必须先升级版本号 + 构建打包 + 安装验证 + push）
alwaysApply: true
---

# code-agent 仓库规则

> 项目级规则：`<repo>/.agent/agent.md`（与全局 `~/.agent/agent.md` 合并生效，项目级后加载）。
> 全局配置目录为 `~/.agent`（旧 `~/.codeagent` 仍兼容并在启动时自动迁移）。

## 1. 代码修改后工作流（Always Active，缺一不可）

**本仓库默认要求**：完成代码修改后，默认执行「升级版本号 → 重新构建打包 → 本地/容器安装验证 →
生成 commit → push」，不要只改代码就结束。

### 1.1 升级版本号（第一步）

修改 `package.json` 的 `version`（默认补丁位 +1，如 `0.3.36` → `0.3.37`；破坏性变更升次版本）。
**必须**在构建前改完，保证 `code-agent-<version>.tgz` 与 commit 一一对应。

### 1.2 重新构建打包

```bash
npm run typecheck          # 类型检查必须先过
npm run test:model-switch  # 模型切换/保底模型相关单测
npm run test:agent-home    # 配置目录（~/.agent）与 agent.md 规则单测
npm run pack               # build:release (esbuild + minify) + npm pack
```

### 1.3 安装 / 运行验证

```bash
node build/agent-cli.js --help          # 至少验证构建产物可运行
# 可选（Docker 不可用则跳过并在报告中注明）
docker build -t code-agent:latest -f Dockerfile .
docker run --rm code-agent:latest code-agent --help
```

### 1.4 生成 commit 并推送

1. `git status` + `git diff --stat` 检查变更
2. 用 `commit` skill 生成规范 message（`<type>: <description>`）
3. `git add -A` → `git commit -m "<message>"` → `git push origin HEAD`
4. 如需同步 GitHub：`git push github HEAD`

## 2. 仓库约定

- 配置目录：全局 `~/.agent`（`config.yaml` / `models.json` / `mcp.json` / `agent.md` / `rules/`
  / `skills/` / `sessions/` / `tasks/`）；项目级 `<repo>/config.yaml`、`<repo>/.agent/agent.md`。
- 旧路径 `~/.codeagent` 保留兼容：读写优先级为新目录优先，旧目录兜底。
- LLM 网关行为以实测证据为准写进注释（如 `llmOpenai.ts` 里 `deepseek-flash` 实为 thinking 模式、
  `reasoning_content` 必须全量回传的 400 规则），不要把猜测当结论。
- 涉及模型切换 / 上下文 / provider 的改动，必须补 `tests/` 单测（本地 HTTP mock 即可），
  并保留「实测日志 + 复现 payload」作为证据。
