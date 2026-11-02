# `--resume` 按工作目录取最近会话

## 问题

裸 `--resume` 原本调用 `AgentSessionManager.getLatestSession()`，它比较的是**整个会话库**的
`updatedAt`。于是「最近的一次会话」几乎不是用户想要的那次——在作者机器上这个库里有
**2163 个会话、分布在 1550 个不同工作目录**，`--resume` 经常直接跳进另一个项目，比手动
`/sessions` + `/resume <id>` 还糟。

复现（实测数据来自 `~/.agents/sessions`）：

```
session files: 2163        distinct working dirs: 1550
top dirs: 104 kurama / 78 code-agent / 56 semi / 50 triton_op / 41 triton_gcu5.0_docs
_index.json: 952 entries, keys = name,mode,createdAt,updatedAt,messageCount,summary
```

两个关键事实决定了修法：

1. **index 里没有 `workingDirectory`**。目录信息只在会话文件本体里，所以「按目录过滤 index」
   做不到。
2. **index 本身是不完整的**。2163 个文件里只有 952 个在 index 中（每月都缺 30%~60%），
   所以「信任 index」会隐藏一多半历史。实测孤儿文件分布：

   | 月份 | 文件数 | 在 index |
   |------|--------|----------|
   | 2026-08 | 414 | 81 |
   | 2026-09 | 971 | 470 |
   | 2026-10 | 459 | 252 |

## 修法

### 语义

| 命令 | 行为 |
|------|------|
| `--resume` / `/resume` | 当前工作目录中 `updatedAt` 最新的会话 |
| `--session <id>` / `/resume <id>` | 显式 id，与目录无关，行为不变 |
| `--resume` 但本目录无会话 | **明确失败**（exit 1）并告知有多少会话在其他目录、用什么命令去找 |
| `/sessions` | 只列**本目录**（与 `/resume`/`--resume` 的解析范围一致） |
| `/sessions all` | 全库列表（跨目录查找的逃生口） |
| `--sessions` | 全库列表，额外显示其中多少条属于本目录 |

`--resume` 找不到会话时**绝不静默回退到别的目录**——静默回退正是被修掉的 bug。

目录比较会归一化：`path.resolve` 展开 `..`/相对路径/重复分隔符，并去掉尾部分隔符，所以
`/repo/` 与 `/repo` 视为同一处。

### 性能：为什么需要 `_cwd_index.json`

正确但朴素的做法是扫全部会话文件，代价无法接受（实测，2163 个文件 / 592 MB）：

| 做法 | 耗时 |
|------|------|
| `statSync` 全部文件 | 16 ms |
| 读完全部字节 | 354 ms |
| **`JSON.parse` 全部** | **2820 ms** |
| 只取 `workingDirectory`+`updatedAt` 的字节级扫描 | **532 ms** |

- 朴素文件扫描版首次查询 **570 ms**、列目录 **2941 ms**——不可接受，而且「减少去查历史会话
  的时间」正是本任务的目标。
- 所以引入侧车索引 `_cwd_index.json`（204 KB，2163 行，`{id: {dir, updatedAt}}`），一次构建后
  所有查询都是内存过滤。

`_rebuildCwdIndex()` **不做 `JSON.parse`**：`scanJsonField()` 在 Buffer 上原地定位
`"workingDirectory"` / `"updatedAt"` 并只解出这两个值（已是 `JSON.stringify` 产物，两个键各出现
一次、不含转义）。已用 250 个文件与完整 `JSON.parse` 交叉验证，**250/250 一致**；路径里若出现
反斜杠转义则返回 `null` 退回「未记录」，不会返回被截断的错误路径。

实测（真实 2163 会话库）：

```
COLD first query:  748 ms   ← 一次性，构建侧车
warm query:        6~8 ms
FRESH PROCESS:      14 ms   ← 侧车已存在，新进程不重建
WARM listSessionsForCwd: 111 ms
```

### 过期检测

侧车在两种情况下失效：版本号不认识，或**存在没有侧车型条目的会话文件**（中断的运行、旧版本
写的文件）。检测只用 `readdirSync`（16 ms），发现缺失即整体重建。

`saveSession()` / `deleteSession()` 会同步维护侧车，所以稳定状态下永不重建。已实测两种场景：

```
#1  resume sees session_old
dropped session_orphan (NEWER, not in _index.json) — interrupted-run simulation
#2  resume must now see the orphan   → Resumed session "session_orphan"
```

顺带修好：`getLatestSession()`（全库最新）也改读侧车，因为侧车覆盖**每一个**会话文件，而
`_index.json` 只覆盖 44%——原来 `/sessions all` 的「最新」其实也漏掉一半。

## 验证

`tests/session-cwd-resume.test.ts`（14 项）固定以下契约：

1. cwd 匹配**优先于**新旧——另一个目录里更新的会话不会被选中（并同时断言旧的全局行为仍是 bug）
2. 已删除的目录、未记录 `workingDirectory` 的会话都不算「本目录」
3. 尾部分隔符的写法仍能匹配
4. **不在 index 里的会话文件仍可被选中**
5. 同目录内取 `updatedAt` 最新，且结果不受 index 顺序影响
6. 本目录无会话时返回 `undefined`，绝不返回别的目录的会话
7. 损坏的会话文件被跳过而非致命
8. 空库不抛异常
9. 显式 `--session <id>` 与目录无关

真机端到端（两个目录各一条会话，B 更新）：

```
repoA --resume → Resumed "session_a"   （取更旧的本地会话，不是更新的 session_b）
repoB --resume → Resumed "session_b"
repoC --resume → No saved session for this directory: /tmp/rt/repoC   (exit 1)
```

## 交付清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/vs/workbench/contrib/agent/common/agentSessions.ts` | 改 | 侧车索引、`getLatestSessionForCwd`、`listSessionsForCwd`、字节级字段扫描 |
| `vs-core/node-runtime/main.ts` | 改 | `--resume` / `/resume` / `/sessions` / `--sessions` 接入 + 帮助文案 |
| `tests/session-cwd-resume.test.ts` | 新增 | 14 项 |