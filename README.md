# CodeAgent

AI coding agent CLI, built on VS Code architecture with multi-provider LLM support and Cursor-compatible skills.

## Features

- **Multi-mode**: Agent (full autonomy), Plan (implementation planning), Ask (read-only Q&A)
- **Multi-provider**: OpenAI, Anthropic, Ollama, and any OpenAI-compatible API (DeepSeek, etc.)
- **YAML config with profiles**: No more juggling environment variables
- **Cursor-compatible Skills**: Load SKILL.md and .mdc rules to extend agent capabilities
- **Streaming output**: Real-time token display
- **Parallel agents**: Run multiple tasks concurrently
- **Single-file distribution**: 44 KB minified, zero runtime dependencies

## Quick Start

```bash
# Install from GitHub Releases
npm install -g https://github.com/zhouronghua/code-agent/releases/latest/download/code-agent-0.2.4.tgz

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
  --mode <agent|plan|ask>     Agent mode (default: agent)
  --stream                    Streaming output
  --parallel "t1" "t2"        Run tasks in parallel
  --profile <name>            Use a config profile
  --profiles                  List available profiles
  --skills                    List loaded skills
  --use-skill <name>          Activate a skill for this session
  --help                      Show help
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
