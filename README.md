# CodeAgent

AI coding agent CLI, built on VS Code architecture with multi-provider LLM support and Cursor-compatible skills.

## Features

- **Multi-mode**: Agent (full autonomy), Plan (implementation planning), Ask (read-only Q&A)
- **Multi-provider**: OpenAI, Anthropic, Ollama, and any OpenAI-compatible API (DeepSeek, etc.)
- **YAML config with profiles**: No more juggling environment variables
- **Cursor-compatible Skills**: Load SKILL.md and .mdc rules to extend agent capabilities
- **Streaming output**: Real-time token display
- **Parallel agents**: Run multiple tasks concurrently
- **Headless batch mode**: `--batch` for cron/CI — no TTY, deterministic exit codes, lock + log + JSON result
- **MCP tools**: Load external MCP servers (streamableHttp / stdio) and expose their tools to the agent
- **Single-file distribution**: 70 KB minified, zero runtime dependencies

## Quick Start

```bash
# Install from GitHub Releases
npm install -g https://github.com/zhouronghua/code-agent/releases/latest/download/zhouronghua-code-agent-0.3.36.tgz

# Or install from GitHub Packages (this repo's npm registry)
npm config set @zhouronghua:registry https://npm.pkg.github.com
npm install -g @zhouronghua/code-agent   # requires a PAT with read:packages

# Create config
mkdir -p ~/.agent
cp $(npm root -g)/@zhouronghua/code-agent/config.template.yaml ~/.agent/config.yaml
# Edit config.yaml: fill in your API key

# Run
code-agent "write a hello world in Python"
code-agent --mode plan "design a REST API"
code-agent --mode ask "explain the project structure"
```

## Usage

```
code-agent [options] "task description"

Options:
  --mode <agent|plan|ask>     Set agent mode (default: agent)
  --stream                    Enable streaming output
  --parallel "t1" "t2"        Run tasks in parallel
  --profile <name>            Use a config profile
  --profiles                  List available profiles
  --skills                    List loaded skills
  --use-skill <name>          Activate a skill for this session
  --session <id>              Resume a specific session by ID
  --resume                    Resume the most recent session
  --sessions                  List saved sessions
  --delete-session <id>       Delete a session
  --tasks                     List saved task logs
  --task <id>                 View a specific task log
  --delete-task <id>          Delete a task log
  --temperature <float>       Override sampling temperature (default from config)
  --top-k <int>               Override top-k sampling; 0 = provider default
  --memory <on|off>           Force shared agent memory on/off for this run
  --batch                     Headless: run the task(s), then exit (no REPL)
  --batch-log <file>          Also append all run output to <file>
  --batch-result <file>       Write a JSON result summary to <file>
  --batch-timeout <seconds>   Overall wall-clock limit (0 = unlimited)
  --lock <file>               Skip the run if another process holds the lock
  --cwd <dir>                 Change working directory before running
  --step-timeout <ms>         Override the per-tool-call timeout
  --mcp <off|on|a,b>          Load MCP servers (on = config.yaml + mcp.json)
  --mcp-tools <a,b,c>         Only expose these MCP tools
  --help                      Show help
  --version, -v               Show version
```

See [USAGE.md](USAGE.md) for full documentation including configuration, skills, distribution, and more.

## Architecture

```
src/vs/workbench/
  services/agent/           # Core models, service interface, LLM providers
  contrib/agent/            # Agent loop, tools, context, skills, config
vs-core/
  base/common/              # VS Code API shims (event, lifecycle, uri, etc.)
  platform/                 # Service interfaces (file, search, terminal)
  node-runtime/             # Node.js service implementations + CLI entry
```

Built with TypeScript, bundled with esbuild into a single executable JS file.

## Build

```bash
npm install
npm run build              # Development build
npm run build:release      # Production build (minified)
npm run build:portable     # Single-file offline binary (Node.js bundled, ~29MB)
npm run pack               # Create distributable .tgz
```

Offline-friendly distribution: `build/agent-cli.js` is a zero-dependency single JS
file that only needs `node >= 18` on the target. If the target machine has no
Node.js / no internet (cannot `npm install`), use `npm run build:portable` and copy
`build/code-agent-portable-linux-x64` — a self-contained executable with the Node
runtime embedded — then run it directly on any Linux host (bash/tar/gzip only).

## License

MIT
