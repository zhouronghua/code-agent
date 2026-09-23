# Self-evolution: find your own defects, then release the fix

> Adapted from the RSI-Harness "harness-rsi" method — a harness whose product is
> another harness. The transferable part is not the artefact, it is the discipline:
> **ground the loop in recorded history, keep facts separate from interpretation,
> bound every read, and publish only through a machine-checked gate.**
>
> Here the subject is code-agent's own source code.

## Why history, and not introspection

An agent reasoning about its own quality from memory produces plausible stories.
The only thing that can distinguish "this tool is broken" from "the user passed a bad
path once" is the execution record. code-agent already writes one: every task saves
`<agent home>/tasks/task_<epoch>_<rand>.json` with per-step LLM requests, every tool
call (arguments, result, success, duration) and the task's status, error and token
usage. `agent_self_scan` reads exactly that.

```
agent_self_scan(days=14)   →   RUN EVIDENCE — last 14 days (37/212 task logs)
                               TOOL USE / FAILURES (grouped) / RUN SIGNALS / NOTES
```

## The loop

### 1. Evidence first

Call `agent_self_scan` **before** proposing anything. It returns facts:

- **failures grouped by normalized error** — the normalizer strips ids, numbers,
  quoted arguments and absolute paths, so one defect repeated 40 times is one line
  with `count: 40` and a list of task ids, not 40 findings;
- **tool histograms** — calls, failures, failure rate, worst latency per tool;
- **run signals** — things that went wrong without an outright failure: a user
  `/btw` correction (the agent's own reasoning was not good enough to continue
  unattended), a 保底-model fallback, a context compaction retry, a degenerate
  reasoning loop, a step-limit hit, a tool the model invented;
- **slowest / costliest tasks** — where the time and tokens actually went.

What it deliberately does **not** do: rank, describe, or read transcripts. Ranking
is interpretation, and interpretation is the reviewer's job. Session transcripts are
never read; only the bounded per-task execution logs are.

### 2. Judge against the intended task, not against elegance

Evidence answers *"is this true"*, never *"is this what you want"*. Every candidate
finding has to pass the same test:

| Evidence | Verdict |
| --- | --- |
| Repeated signature (≥3 occurrences, or a high failure rate on a common tool) | Candidate defect — investigate |
| Single occurrence with a user-supplied bad argument | Not a defect — the user made a mistake |
| One-off timeout under load | Not a defect — noise |
| Evidence that supports two readings | **Say both and ask** — never pick the reading that is easier to write up |

A finding with strong evidence that does not serve the user's task is worth one
sentence and then dropped. A finding that serves the task but has thin evidence is a
question, not a decision.

### 3. Read only what the signature points at

Find the code path behind the group (grep the tool name or the error text), then make
the **smallest change that removes the failure mode**. Do not refactor neighbours, do
not "improve while you are in there" — an unrelated edit makes the fix unreviewable
and the release untestable.

### 4. Write the failing case down first

Add or extend a test that **fails before** the change and **passes after** it. If the
defect is in the release path itself, unit-test the pieces with an injected command
runner rather than shelling out. No test, no release.

### 5. Say the plan out loud before editing

State: what you are changing, why the evidence supports it, and **what you decided
not to change**. If the plan turns out to be impossible midway, stop and explain the
alternative. Never silently swap one approach for another — a plan that drifted
without being restated is not approved.

### 6. Release through the gate

```
agent_release(message="fix: ...", bump="patch", push=false)
```

The pipeline is deliberately not something the model improvises:

| Step | Contract |
| --- | --- |
| `read-package.json` | version must be semver |
| `git-repository` | must be a git repo |
| `git-state` | refuses mid-merge / mid-rebase / unmerged files |
| `git-branch` | refuses to push from a detached HEAD |
| `bump-version` | semver patch/minor/major |
| `npm run typecheck`, `npm run test`, `npm run pack` | configurable via `release_scripts` |
| `install` | optional extra command |
| `smoke built CLI` | `node build/agent-cli.js --version` must report the **new** version |
| `git add -A`, `git commit -F -` | never `--amend`, never `--no-verify` |
| `git push <remote> HEAD` | only when `self_update.allow_push` is true; never `--force` |

Failure behaviour is the important part: it **aborts at the first failure**, so a red
test suite can never produce a commit; and if it aborts before committing it restores
`package.json` to the previous version, so the tree is not left half-released. Every
step it actually ran is appended to the commit message as a `Verified-by:` trailer —
"已推送" is not the same as "已验证".

### 7. Report the pipeline, not your hope

Paste the step-by-step report. If it aborted, say where and why, and fix that instead
of re-running until green.

## Configuration

```yaml
# ~/.agent/config.yaml  (or ./config.yaml for one project)
self_update:
  enabled: true            # register agent_self_scan (read-only)
  allow_release: false     # register agent_release (writes the repo, commits)
  allow_push: false        # ...and let it push (requires allow_release)
  evidence_days: 14
  evidence_tasks: 200
  remote: origin
  release_scripts: ["typecheck", "test", "pack"]
  install_command: ""
```

Verify with a dry run before trusting it:

```bash
code-agent --self-scan 30                 # facts only, no LLM call
# then, inside a session, ask for a dry run:
#   "check your own evidence from the last 30 days and release a fix, dry_run first"
```

## Boundaries

- Self-evolution changes **code**, and code changes carry risk. `allow_release`
  defaults to **off** for exactly that reason.
- The evidence base is task logs, so a defect that never produced a failure signal
  (a wrong-but-plausible answer) is invisible to it. That is a real limit, not a bug.
- Do not let the loop become a loop: one finding → one minimal fix → one release.
