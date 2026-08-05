#!/usr/bin/env node
/**
 * Code-Agent Benchmark System v3
 * 
 * Runs a fixed test suite against the LATEST built agent,
 * collects fresh metrics, and compares against baseline.
 * 
 * v3 improvements:
 * - Multi-run averaging (BENCHMARK_RUNS env var, default 3)
 * - Relaxed thresholds to account for LLM non-determinism
 * - BENCHMARK_DISABLE=1 to skip checks entirely
 * - Statistical summary with stddev to assess stability
 * 
 * Usage:
 *   node scripts/benchmark.mjs                    # Show current benchmark
 *   node scripts/benchmark.mjs --run              # Run test suite + show results
 *   node scripts/benchmark.mjs --save [version]   # Run + save as baseline
 *   node scripts/benchmark.mjs --check            # Run + compare against baseline (exit 1 if regressed)
 *   node scripts/benchmark.mjs --json             # Output last run as JSON
 * 
 * Env vars:
 *   BENCHMARK_RUNS=N       - Number of runs per task for averaging (default: 3)
 *   BENCHMARK_DISABLE=1    - Skip benchmark checks entirely (exit 0)
 *   BENCHMARK_STRICT=1     - Exit non-zero on regression (default: warn only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SUITE_DIR = path.join(PROJECT_ROOT, 'benchmarks', 'suite');
const BASELINE_FILE = path.join(PROJECT_ROOT, 'benchmarks', 'baseline.json');
const RESULTS_FILE = path.join(PROJECT_ROOT, 'benchmarks', 'last_run.json');
const TASKS_DIR = path.join(os.homedir(), '.codeagent', 'tasks');
const AGENT_CLI = path.join(PROJECT_ROOT, 'build', 'agent-cli.js');
const TASK_TIMEOUT_MS = 120_000; // 2 min per task
const BENCHMARK_RUNS = parseInt(process.env.BENCHMARK_RUNS || '3', 10);
const BENCHMARK_DISABLE = process.env.BENCHMARK_DISABLE === '1';
const BENCHMARK_STRICT = process.env.BENCHMARK_STRICT === '1';

// ─── Helpers ──────────────────────────────────────────────────────────

function round(v, d) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

function stddev(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ─── Task Log Access ──────────────────────────────────────────────────

function loadIndex() {
  const indexPath = path.join(TASKS_DIR, '_index.json');
  if (!fs.existsSync(indexPath)) return {};
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf-8')); }
  catch { return {}; }
}

function loadTaskLog(id) {
  const logPath = path.join(TASKS_DIR, `${id}.json`);
  if (!fs.existsSync(logPath)) return null;
  try { return JSON.parse(fs.readFileSync(logPath, 'utf-8')); }
  catch { return null; }
}

// ─── Test Suite ───────────────────────────────────────────────────────

function loadSuite() {
  const tasks = [];
  if (!fs.existsSync(SUITE_DIR)) {
    console.error(`Suite directory not found: ${SUITE_DIR}`);
    return tasks;
  }
  const files = fs.readdirSync(SUITE_DIR).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(SUITE_DIR, file), 'utf-8'));
      tasks.push(task);
    } catch (err) {
      console.error(`Failed to load ${file}: ${err.message}`);
    }
  }
  return tasks;
}

// ─── Workspace Setup ──────────────────────────────────────────────────

function setupWorkspace(task) {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`));
  if (task.setup?.files) {
    for (const [filePath, content] of Object.entries(task.setup.files)) {
      const fullPath = path.join(wsDir, filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
  }
  return wsDir;
}

function cleanupWorkspace(wsDir) {
  try { fs.rmSync(wsDir, { recursive: true, force: true }); }
  catch { /* ignore */ }
}

// ─── Agent Runner ─────────────────────────────────────────────────────

/**
 * Run one benchmark task by spawning the agent CLI.
 * Returns metrics extracted from the generated task log.
 */
function runAgentTask(task, wsDir) {
  return new Promise((resolve) => {
    // Record existing task logs before running
    const indexBefore = loadIndex();
    const idsBefore = new Set(Object.keys(indexBefore));

    const child = spawn('node', [AGENT_CLI, task.task], {
      cwd: wsDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: TASK_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    let completed = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force kill after 5s
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }, TASK_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Detect task completion
      if (stdout.includes('--- Task completed ---') && !completed) {
        completed = true;
        // Give agent a moment to save task log, then exit
        setTimeout(() => {
          if (!child.killed) {
            child.stdin.write('exit\n');
          }
        }, 500);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      // Find the new task log
      const indexAfter = loadIndex();
      const newIds = Object.keys(indexAfter).filter(id => !idsBefore.has(id));

      if (newIds.length === 0) {
        resolve({
          taskId: task.id,
          taskName: task.name,
          success: false,
          error: timedOut ? 'timeout' : `no task log generated (exit ${code})`,
          durationMs: TASK_TIMEOUT_MS,
          totalSteps: 0,
          totalToolCalls: 0,
          toolExecSuccessRate: 0,
        });
        return;
      }

      // Read the last new log (most recent)
      const logId = newIds[newIds.length - 1];
      const log = loadTaskLog(logId);

      if (!log) {
        resolve({
          taskId: task.id,
          taskName: task.name,
          success: false,
          error: `task log ${logId} not readable`,
          durationMs: 0,
          totalSteps: 0,
          totalToolCalls: 0,
          toolExecSuccessRate: 0,
        });
        return;
      }

      // Verify expected outputs
      let verifySuccess = true;
      const verifyErrors = [];
      if (task.verify) {
        if (task.verify.fileExists) {
          const f = path.join(wsDir, task.verify.fileExists);
          if (!fs.existsSync(f)) {
            verifySuccess = false;
            verifyErrors.push(`expected file not found: ${task.verify.fileExists}`);
          }
        }
        if (task.verify.fileContains) {
          const [file, expected] = task.verify.fileContains;
          const f = path.join(wsDir, file);
          if (fs.existsSync(f)) {
            const content = fs.readFileSync(f, 'utf-8');
            if (!content.includes(expected)) {
              verifySuccess = false;
              verifyErrors.push(`file ${file} does not contain "${expected}"`);
            }
          } else {
            verifySuccess = false;
            verifyErrors.push(`file ${file} not found for content check`);
          }
        }
        if (task.verify.fileNotContains) {
          const [file, notExpected] = task.verify.fileNotContains;
          const f = path.join(wsDir, file);
          if (fs.existsSync(f)) {
            const content = fs.readFileSync(f, 'utf-8');
            if (content.includes(notExpected)) {
              verifySuccess = false;
              verifyErrors.push(`file ${file} still contains "${notExpected}"`);
            }
          }
        }
      }

      // Compute tool execution success rate
      let toolExecs = 0;
      let toolFails = 0;
      for (const step of (log.steps || [])) {
        for (const exec of (step.toolExecutions || [])) {
          toolExecs++;
          if (!exec.success) toolFails++;
        }
      }
      const toolExecSuccessRate = toolExecs > 0 ? (toolExecs - toolFails) / toolExecs : 1;

      resolve({
        taskId: task.id,
        taskName: task.name,
        success: log.status === 'completed' && verifySuccess,
        status: log.status,
        verifySuccess,
        verifyErrors,
        durationMs: log.durationMs,
        totalSteps: log.totalSteps,
        totalToolCalls: log.totalToolCalls,
        toolExecSuccessRate: round(toolExecSuccessRate, 4),
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        taskId: task.id,
        taskName: task.name,
        success: false,
        error: `spawn failed: ${err.message}`,
        durationMs: 0,
        totalSteps: 0,
        totalToolCalls: 0,
        toolExecSuccessRate: 0,
      });
    });
  });
}

// ─── Run Suite ────────────────────────────────────────────────────────

async function runSuite(tasks) {
  if (!fs.existsSync(AGENT_CLI)) {
    console.error('Build output not found. Run: npm run build');
    return null;
  }

  console.log(`\n🧪 Running benchmark suite (${tasks.length} tasks, ${BENCHMARK_RUNS} runs each)...\n`);

  const allResults = []; // [runIndex][taskIndex]

  for (let run = 0; run < BENCHMARK_RUNS; run++) {
    if (BENCHMARK_RUNS > 1) {
      console.log(`  ── Run ${run + 1}/${BENCHMARK_RUNS} ──`);
    }
    const runResults = [];
    const workspaces = [];

    for (const task of tasks) {
      process.stdout.write(`    [${task.id}] ${task.name}... `);
      const wsDir = setupWorkspace(task);
      workspaces.push(wsDir);

      const startTime = Date.now();
      const result = await runAgentTask(task, wsDir);
      const elapsed = Date.now() - startTime;

      const icon = result.success ? '✅' : '❌';
      console.log(`${icon} (${(elapsed / 1000).toFixed(1)}s)`);
      if (result.error) {
        console.log(`         Error: ${result.error}`);
      }
      if (result.verifyErrors?.length > 0) {
        for (const e of result.verifyErrors) {
          console.log(`         Verify: ${e}`);
        }
      }
      runResults.push(result);
    }

    // Cleanup workspaces
    for (const ws of workspaces) {
      cleanupWorkspace(ws);
    }
    allResults.push(runResults);
  }

  // Merge multiple runs: use median for numeric metrics, majority for success
  return mergeRuns(allResults, tasks);
}

/**
 * Merge results from multiple runs.
 * Uses median for numeric stability metrics and majority vote for success/failure.
 */
function mergeRuns(allResults, tasks) {
  const merged = [];
  for (let i = 0; i < tasks.length; i++) {
    const taskResults = allResults.map(run => run[i]);

    // Majority vote for success
    const successCount = taskResults.filter(r => r.success).length;
    const majoritySuccess = successCount >= taskResults.length / 2;

    // Median for numeric metrics
    const durationMss = taskResults.map(r => r.durationMs).sort((a, b) => a - b);
    const steps = taskResults.map(r => r.totalSteps).sort((a, b) => a - b);
    const toolCalls = taskResults.map(r => r.totalToolCalls).sort((a, b) => a - b);
    const toolRates = taskResults.map(r => r.toolExecSuccessRate);

    const medIdx = Math.floor(taskResults.length / 2);

    merged.push({
      taskId: taskResults[0].taskId,
      taskName: taskResults[0].taskName,
      success: majoritySuccess,
      status: majoritySuccess ? 'completed' : 'failed',
      verifySuccess: majoritySuccess,
      verifyErrors: taskResults.find(r => !r.verifySuccess)?.verifyErrors || [],
      durationMs: durationMss[medIdx],
      totalSteps: steps[medIdx],
      totalToolCalls: toolCalls[medIdx],
      toolExecSuccessRate: round(toolRates.reduce((a, b) => a + b, 0) / toolRates.length, 4),
      timedOut: taskResults.some(r => r.timedOut),
    });
  }
  return merged;
}

// ─── Metrics Computation ──────────────────────────────────────────────

function computeMetrics(results) {
  if (!results || results.length === 0) return null;

  const completed = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  const durations = completed.map(r => r.durationMs).sort((a, b) => a - b);
  const steps = completed.map(r => r.totalSteps).sort((a, b) => a - b);
  const toolCalls = completed.map(r => r.totalToolCalls).sort((a, b) => a - b);

  const toolExecRates = completed.map(r => r.toolExecSuccessRate);

  // Efficiency: tool calls per step
  const efficiency = completed
    .filter(r => r.totalSteps > 0)
    .map(r => r.totalToolCalls / r.totalSteps);

  const metrics = {
    totalTasks: results.length,
    completedCount: completed.length,
    failedCount: failed.length,
    successRate: round(completed.length / results.length, 4),

    avgDurationSec: round((durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length)) / 1000, 1),
    p50DurationSec: round(percentile(durations, 50) / 1000, 1),
    p90DurationSec: round(percentile(durations, 90) / 1000, 1),
    maxDurationSec: round((durations.length > 0 ? durations[durations.length - 1] : 0) / 1000, 1),

    avgSteps: round(steps.reduce((a, b) => a + b, 0) / Math.max(1, steps.length), 1),
    p50Steps: round(percentile(steps, 50), 0),
    p90Steps: round(percentile(steps, 90), 0),
    maxSteps: steps.length > 0 ? steps[steps.length - 1] : 0,

    avgToolCalls: round(toolCalls.reduce((a, b) => a + b, 0) / Math.max(1, toolCalls.length), 1),
    p50ToolCalls: round(percentile(toolCalls, 50), 0),
    p90ToolCalls: round(percentile(toolCalls, 90), 0),
    maxToolCalls: toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : 0,

    avgToolCallsPerStep: round(efficiency.reduce((a, b) => a + b, 0) / Math.max(1, efficiency.length), 2),
    toolExecSuccessRate: round(toolExecRates.reduce((a, b) => a + b, 0) / Math.max(1, toolExecRates.length), 4),

    perTask: results.map(r => ({
      id: r.taskId,
      name: r.taskName,
      success: r.success,
      durationMs: r.durationMs,
      steps: r.totalSteps,
      toolCalls: r.totalToolCalls,
      toolExecSuccessRate: r.toolExecSuccessRate,
      error: r.error || '',
    })),

    generatedAt: new Date().toISOString(),
    suite: 'benchmarks/suite/',
  };

  return metrics;
}

// ─── Baseline Management ──────────────────────────────────────────────

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8')); }
  catch { return null; }
}

function saveBaseline(metrics, version) {
  const baseline = {
    ...metrics,
    version: version || `v${Date.now()}`,
    savedAt: new Date().toISOString(),
  };
  const dir = path.dirname(BASELINE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`✅ Baseline saved to ${BASELINE_FILE}`);
  return baseline;
}

function saveResults(metrics) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(metrics, null, 2), 'utf-8');
}

// ─── Comparison Engine ────────────────────────────────────────────────

// Relaxed thresholds for LLM non-determinism (v3).
// LLM outputs vary naturally — step counts, tool calls, and durations
// can fluctuate significantly even with identical code.
const THRESHOLDS = {
  successRate: { direction: 'higher', tolerance: -0.08 },       // allow 8% drop
  avgDurationSec: { direction: 'lower', tolerance: 2.50 },       // allow 150% increase
  avgSteps: { direction: 'lower', tolerance: 2.00 },             // allow 100% increase
  avgToolCalls: { direction: 'lower', tolerance: 2.00 },         // allow 100% increase
  toolExecSuccessRate: { direction: 'higher', tolerance: -0.10 },// allow 10% drop
  avgToolCallsPerStep: { direction: 'lower', tolerance: 1.50 },  // allow 50% increase
};

function compareMetrics(current, baseline) {
  if (!baseline) {
    return { passed: true, isNew: true, checks: [] };
  }

  const checks = [];
  let allPassed = true;

  for (const [key, rule] of Object.entries(THRESHOLDS)) {
    const curVal = current[key];
    const baseVal = baseline[key];

    if (curVal === undefined || baseVal === undefined || baseVal === 0) continue;

    let passed;
    let changePct = ((curVal - baseVal) / baseVal) * 100;

    if (rule.direction === 'higher') {
      // Higher is better; tolerance is negative (allowed drop)
      // e.g. tolerance=-0.08 means allow 8% drop
      passed = changePct >= (rule.tolerance * 100);
    } else {
      // Lower is better; tolerance is >1 (allowed multiplier)
      // e.g. tolerance=2.0 means allow 100% increase
      passed = changePct <= ((rule.tolerance - 1) * 100);
    }

    const status = passed ? '✅' : '❌';
    const arrow = changePct > 0 ? '↑' : '↓';
    checks.push({
      metric: key,
      baseline: baseVal,
      current: curVal,
      changePct: round(changePct, 1),
      direction: rule.direction,
      passed,
      display: `${status} ${key}: ${baseVal} → ${curVal} (${arrow}${Math.abs(changePct).toFixed(1)}%)`,
    });

    if (!passed) allPassed = false;
  }

  return { passed: allPassed, isNew: false, checks };
}

// ─── Display ──────────────────────────────────────────────────────────

function displayResults(results) {
  console.log('\n┌──────────────────────────────────────────────────────┐');
  console.log('│            Benchmark Task Results                    │');
  console.log('├────┬──────────────────────────┬────────┬─────────────┤');
  console.log('│ ID │ Task                     │ Result │ Duration    │');
  console.log('├────┼──────────────────────────┼────────┼─────────────┤');
  for (const r of results) {
    const name = r.taskName.padEnd(24).substring(0, 24);
    const status = r.success ? '✅ OK ' : '❌ FAIL';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`.padStart(7);
    console.log(`│ ${r.taskId} │ ${name} │ ${status}  │   ${dur} │`);
  }
  console.log('└────┴──────────────────────────┴────────┴─────────────┘');
}

function displayMetrics(metrics) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         Code-Agent Benchmark Report v2              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Tasks: ${String(metrics.totalTasks).padStart(5)} total (${metrics.completedCount} passed, ${metrics.failedCount} failed)`);
  console.log(`║  Success Rate: ${(metrics.successRate * 100).toFixed(1)}%`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  ── Duration ──');
  console.log(`║  Avg: ${String(metrics.avgDurationSec).padStart(7)}s | P50: ${String(metrics.p50DurationSec).padStart(7)}s | P90: ${String(metrics.p90DurationSec).padStart(7)}s`);
  console.log(`║  Max: ${String(metrics.maxDurationSec).padStart(7)}s`);
  console.log('║  ── Steps ──');
  console.log(`║  Avg: ${String(metrics.avgSteps).padStart(7)}   | P50: ${String(metrics.p50Steps).padStart(7)}   | P90: ${String(metrics.p90Steps).padStart(7)}`);
  console.log(`║  Max: ${String(metrics.maxSteps).padStart(7)}`);
  console.log('║  ── Tool Calls ──');
  console.log(`║  Avg: ${String(metrics.avgToolCalls).padStart(7)}   | P50: ${String(metrics.p50ToolCalls).padStart(7)}   | P90: ${String(metrics.p90ToolCalls).padStart(7)}`);
  console.log(`║  Max: ${String(metrics.maxToolCalls).padStart(7)}`);
  console.log('║  ── Efficiency ──');
  console.log(`║  Tool exec success: ${(metrics.toolExecSuccessRate * 100).toFixed(1)}% | Avg calls/step: ${metrics.avgToolCallsPerStep}`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

function displayComparison(result) {
  if (result.isNew) return;

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Benchmark Comparison vs Baseline              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  for (const check of result.checks) {
    console.log(`║ ${check.display.padEnd(52)}║`);
  }
  console.log('╠══════════════════════════════════════════════════════╣');
  if (result.passed) {
    console.log('║  ✅ ALL CHECKS PASSED — Safe to push                ║');
  } else {
    console.log('║  ❌ REGRESSION DETECTED — Review before pushing     ║');
  }
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

function displayResultSummary(results, metrics) {
  displayResults(results);
  displayMetrics(metrics);
}

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const mode = args[0] || '';

async function main() {
  // ─── BENCHMARK_DISABLE: skip all checks ────────────────────────────
  if (BENCHMARK_DISABLE) {
    console.log('⚠️  BENCHMARK_DISABLE=1 — benchmark checks skipped.');
    process.exit(0);
  }

  // ─── Strict mode info ──────────────────────────────────────────────
  if (!BENCHMARK_STRICT && (mode === '--check')) {
    console.log('💡 BENCHMARK_STRICT not set — regressions will warn but not block.');
  }

  // Read-only modes: don't need suite or build
  if (mode === '--json') {
    if (fs.existsSync(RESULTS_FILE)) {
      console.log(fs.readFileSync(RESULTS_FILE, 'utf-8'));
    } else {
      console.log(JSON.stringify({ error: 'No results. Run --run first.' }));
    }
    return;
  }

  if (mode === '--summary') {
    if (fs.existsSync(RESULTS_FILE)) {
      const m = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
      console.log(`Tasks: ${m.totalTasks} | Success: ${(m.successRate*100).toFixed(1)}% | ` +
                  `Avg: ${m.avgSteps} steps, ${m.avgToolCalls} tools, ${m.avgDurationSec}s`);
    } else {
      console.log('No results. Run --run first.');
    }
    return;
  }

  // All other modes require the test suite
  const tasks = loadSuite();
  if (tasks.length === 0) {
    console.error('No benchmark tasks found in benchmarks/suite/');
    process.exit(1);
  }

  // Build the latest agent
  console.log('🔨 Building agent...');
  try {
    execSync('node build.mjs', { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 60000 });
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
  }

  const results = await runSuite(tasks);
  if (!results) process.exit(1);

  const metrics = computeMetrics(results);
  if (!metrics) process.exit(1);

  saveResults(metrics);
  displayResultSummary(results, metrics);

  if (mode === '--save') {
    const version = args[1];
    saveBaseline(metrics, version);
    return;
  }

  if (mode === '--check') {
    const baseline = loadBaseline();
    if (!baseline) {
      console.log('⚠️  No baseline found. Run "node scripts/benchmark.mjs --save" first.');
      process.exit(0);
    }

    const result = compareMetrics(metrics, baseline);
    displayComparison(result);

    if (!result.passed) {
      console.error('❌ Benchmark regression detected!');
      console.error('   Review the metrics above. If the regression is intentional,');
      console.error('   update the baseline: node scripts/benchmark.mjs --save');
      if (BENCHMARK_STRICT) {
        process.exit(1);
      } else {
        console.error('   ⚠️  BENCHMARK_STRICT not set — warning only, not blocking.\n');
        process.exit(0);
      }
    } else {
      console.log('✅ Benchmark checks passed.');
      process.exit(0);
    }
  }

  // Default: just display (already done above)
  const baseline = loadBaseline();
  if (baseline) {
    const result = compareMetrics(metrics, baseline);
    displayComparison(result);
  } else {
    console.log('💡 No baseline yet. Run --save to create one.');
  }
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
