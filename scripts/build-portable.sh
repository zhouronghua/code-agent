#!/usr/bin/env bash
# =============================================================================
# build-portable.sh — 把 code-agent 打包成"拷贝即用"的单文件可执行版本
#
# 产物: build/code-agent-portable-linux-x64
#   一个自包含文件（内嵌 Node.js 运行时 + 编译后的 agent-cli.js）。
#   拷贝到其它 Linux 机器后直接执行即可，目标机不需要安装 Node.js、
#   不需要 npm install、不需要访问外网。
#
# 用法:
#   bash scripts/build-portable.sh                # 使用当前 PATH 里的 node 作为内嵌运行时
#   NODE_SRC_BIN=/path/to/node bash scripts/build-portable.sh   # 指定内嵌的 node 二进制
#
# 说明:
#   - 内嵌运行时会优先做 strip 以减小体积（失败不影响产物）。
#   - 产物运行时把内嵌内容解压到 ${XDG_CACHE_HOME:-~/.cache}/codeagent-run/<指纹> 并缓存，
#     首次运行稍慢，之后直接复用缓存，接近原生启动速度。
#   - 产物只依赖目标机的 bash / tar / gzip（Linux 基本都自带）。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

# 1) 内嵌的 Node 运行时（默认取当前 PATH 中的 node，要求能在目标机同样运行）
NODE_SRC_BIN="${NODE_SRC_BIN:-$(command -v node || true)}"
if [ -z "$NODE_SRC_BIN" ] || [ ! -x "$NODE_SRC_BIN" ]; then
	echo "error: cannot find a Node.js binary to embed. set NODE_SRC_BIN=/path/to/node" >&2
	exit 1
fi

# 2) 构建 release 单文件 bundle
echo ">> building release bundle ..."
npm run build:release >/dev/null

out="build/code-agent-portable-linux-x64"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 3) 准备内嵌内容: node(已 strip) + agent-cli.js + 配置模板
cp "$NODE_SRC_BIN" "$work/node"
chmod +x "$work/node"
strip "$work/node" 2>/dev/null && echo ">> stripped embedded node" || true
cp build/agent-cli.js        "$work/agent-cli.js"
cp build/config.template.yaml "$work/config.template.yaml"
echo ">> embedded node: $("$NODE_SRC_BIN" --version)  from: $NODE_SRC_BIN"

# 4) 压缩
tar -C "$work" -czf "$work/payload.tgz" node agent-cli.js config.template.yaml

# 5) 拼装: launcher 头 + 分隔标记 + 二进制 payload
build_id="$(date +%s)"
{
	cat <<EOF
#!/usr/bin/env bash
# code-agent — portable single-file runtime (Node.js bundled inside)
# 由 scripts/build-portable.sh 生成, 请勿直接编辑本文件头部
set -euo pipefail
BUILD_ID=$build_id
self="\$(readlink -f "\$0" 2>/dev/null || echo "\$0")"
marker='#__PAYLOAD_BELOW__'
line="\$(grep -a -n -m1 -E '^#__PAYLOAD_BELOW__\$' "\$self" | cut -d: -f1)"
off="\$(head -n "\$line" "\$self" | wc -c)"
sig="\$(wc -c < "\$self")-\$BUILD_ID"
dir_candidates="\${XDG_CACHE_HOME:-\$HOME/.cache}/codeagent-run \${TMPDIR:-/tmp}/codeagent-run"
nodebin=""; js=""
for d in \$dir_candidates; do
  if [ ! -x "\$d/\$sig/node" ]; then
    mkdir -p "\$d/\$sig" 2>/dev/null && tail -c +"\$((off+1))" "\$self" | tar -xz -C "\$d/\$sig" 2>/dev/null || { rm -rf "\$d/\$sig" 2>/dev/null; continue; }
  fi
  if [ -x "\$d/\$sig/node" ] && [ -f "\$d/\$sig/agent-cli.js" ]; then nodebin="\$d/\$sig/node"; js="\$d/\$sig/agent-cli.js"; break; fi
done
if [ -z "\$nodebin" ]; then echo "error: failed to extract embedded runtime" >&2; exit 1; fi
exec "\$nodebin" "\$js" "\$@"
EOF
	printf '%s\n' '#__PAYLOAD_BELOW__'
	cat "$work/payload.tgz"
} > "$out"
chmod +x "$out"

size="$(du -h "$out" | cut -f1)"
echo "OK: $out ($size)  — 拷贝到目标 Linux 机器后执行: ./$out --help"
