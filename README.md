# CodeAgent

AI coding agent CLI, built on VS Code architecture with multi-provider LLM support and Cursor-compatible skills.

## Features

- **Multi-mode**: Agent (full autonomy), Plan (implementation planning), Ask (read-only Q&A)
- **Multi-provider**: OpenAI, Anthropic, Ollama, and any OpenAI-compatible API (DeepSeek, etc.)
- **YAML config with profiles**: No more juggling environment variables
- **Cursor-compatible Skills**: Load SKILL.md and .mdc rules to extend agent capabilities
- **Streaming output**: Real-time token display
- **Parallel agents**: Run multiple tasks concurrently
- **Single-file distribution**: 70 KB minified, zero runtime dependencies

## Quick Start

```bash
# Install from GitHub Releases
npm install -g https://github.com/zhouronghua/code-agent/releases/latest/download/code-agent-0.3.10.tgz

# Or install from npm (if published)
npm install -g code-agent

# Create config
mkdir -p ~/.codeagent
cp $(npm root -g)/code-agent/config.template.yaml ~/.codeagent/config.yaml
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
npm run pack               # Create distributable .tgz
```

## License

MIT
