#!/usr/bin/env node
/**
 * Code-Agent Benchmark System
 * 
 * Extracts performance metrics from task execution logs, manages baselines,
 * and validates that new changes don't regress agent quality.
 * 
 * Usage:
 *   node scripts/benchmark.mjs                    # Show current benchmark data
 *   node scripts/benchmark.mjs --save [version]   # Save current state as baseline
 *   node scripts/benchmark.mjs --check            # Compare against baseline (exit 1 if worse)
 *   node scripts/benchmark.mjs --summary          # Print summary only
 *   node scripts/benchmark.mjs --json             # Output as JSON
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(os.homedir(), '.codeagent', 'tasks');
const BENCHMARK_FILE = path.join(PROJECT_ROOT, 'benchmark_baseline.json');

// ─── Helpers ──────────────────────────────────────────────────────────

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

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ─── Metrics Extraction ───────────────────────────────────────────────

function computeMetrics() {
  const index = loadIndex();
  const entries = Object.values(index);
  if (entries.length === 0) {
    console.error('No task logs found in ~/.codeagent/tasks/');
    return null;
  }

  const completed = entries.filter(e => e.status === 'completed');
  const failed = entries.filter(e => e.status === 'failed');

  // Basic stats
  const totalTasks = entries.length;
  const completedCount = completed.length;
  const failedCount = failed.length;
  const successRate = completedCount / totalTasks;

  // Duration stats (only completed tasks, exclude outliers < 5s as likely aborted)
  const validCompleted = completed.filter(e => e.durationMs >= 5000);
  const durations = validCompleted.map(e => e.durationMs).sort((a, b) => a - b);
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  // Steps stats
  const steps = completed.map(e => e.totalSteps).sort((a, b) => a - b);
  const avgSteps = steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;

  // Tool calls stats
  const toolCalls = completed.map(e => e.totalToolCalls).sort((a, b) => a - b);
  const avgToolCalls = toolCalls.length > 0 ? toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length : 0;

  // ─── Deep metrics from full task logs ───
  let totalLLMSteps = 0;
  let totalToolExecutions = 0;
  let totalToolFailures = 0;
  let totalStepDuration = 0;
  let stepCount = 0;
  let toolExecSuccessRate = 1.0;
  let avgStepDuration = 0;
  let maxStepsInTask = 0;
  
  // Tool usage distribution
  const toolUsage = {};
  
  // Sample a subset of full logs for deep analysis (to avoid parsing huge files)
  const sampleSize = Math.min(30, completed.length);
  const sampled = completed.slice(-sampleSize); // Most recent

  for (const entry of sampled) {
    const log = loadTaskLog(entry.id);
    if (!log || !log.steps) continue;
    
    totalLLMSteps += log.steps.length;
    maxStepsInTask = Math.max(maxStepsInTask, log.steps.length);
    
    for (const step of log.steps) {
      stepCount++;
      totalStepDuration += step.durationMs || 0;
      
      if (step.toolExecutions) {
        for (const exec of step.toolExecutions) {
          totalToolExecutions++;
          if (!exec.success) totalToolFailures++;
          
          // Track tool usage
          const toolName = exec.toolName || 'unknown';
          toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
        }
      }
    }
  }

  if (totalToolExecutions > 0) {
    toolExecSuccessRate = (totalToolExecutions - totalToolFailures) / totalToolExecutions;
  }
  if (stepCount > 0) {
    avgStepDuration = totalStepDuration / stepCount;
  }

  // Efficiency: tool calls per step (for completed tasks)
  const efficiency = steps.length > 0 
    ? toolCalls.map((tc, i) => tc / Math.max(1, steps[i] || 1))
    : [];
  const avgEfficiency = efficiency.length > 0 
    ? efficiency.reduce((a, b) => a + b, 0) / efficiency.length 
    : 0;

  // Distribution metrics (more stable than averages)
  const metrics = {
    // ─── Core KPIs ───
    totalTasks,
    completedCount,
    failedCount,
    successRate: round(successRate, 4),
    
    // ─── Duration (seconds) ───
    avgDurationSec: round(avgDuration / 1000, 1),
    p50DurationSec: round(percentile(durations, 50) / 1000, 1),
    p90DurationSec: round(percentile(durations, 90) / 1000, 1),
    p95DurationSec: round(percentile(durations, 95) / 1000, 1),
    maxDurationSec: round((durations.length > 0 ? durations[durations.length - 1] : 0) / 1000, 1),
    
    // ─── Steps ───
    avgSteps: round(avgSteps, 1),
    p50Steps: round(percentile(steps, 50), 0),
    p90Steps: round(percentile(steps, 90), 0),
    maxSteps: steps.length > 0 ? steps[steps.length - 1] : 0,
    
    // ─── Tool Calls ───
    avgToolCalls: round(avgToolCalls, 1),
    p50ToolCalls: round(percentile(toolCalls, 50), 0),
    p90ToolCalls: round(percentile(toolCalls, 90), 0),
    maxToolCalls: toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : 0,
    
    // ─── Efficiency ───
    avgToolCallsPerStep: round(avgEfficiency, 2),
    toolExecSuccessRate: round(toolExecSuccessRate, 4),
    
    // ─── Deep metrics (from sampled logs) ───
    sampledTaskCount: sampled.length,
    avgStepDurationMs: round(avgStepDuration, 0),
    maxStepsInSingleTask: maxStepsInTask,
    toolUsageDistribution: toolUsage,
    
    // ─── Metadata ───
    generatedAt: new Date().toISOString(),
    tasksDir: TASKS_DIR,
    allMode: entries[0]?.mode || 'unknown',
  };

  return metrics;
}

function round(v, d) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

// ─── Baseline Management ──────────────────────────────────────────────

function loadBaseline() {
  if (!fs.existsSync(BENCHMARK_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BENCHMARK_FILE, 'utf-8')); }
  catch { return null; }
}

function saveBaseline(metrics, version) {
  const baseline = {
    ...metrics,
    version: version || `v${Date.now()}`,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(BENCHMARK_FILE, JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`✅ Baseline saved to ${BENCHMARK_FILE}`);
  return baseline;
}

// ─── Comparison Engine ────────────────────────────────────────────────

const THRESHOLDS = {
  successRate: { direction: 'higher', tolerance: -0.02 },     // Allow 2% drop
  avgDurationSec: { direction: 'lower', tolerance: 1.20 },    // Allow 20% increase
  avgSteps: { direction: 'lower', tolerance: 1.15 },          // Allow 15% increase
  avgToolCalls: { direction: 'lower', tolerance: 1.15 },      // Allow 15% increase
  toolExecSuccessRate: { direction: 'higher', tolerance: -0.03 }, // Allow 3% drop
  avgToolCallsPerStep: { direction: 'lower', tolerance: 1.10 },  // Allow 10% increase
};

function compareMetrics(current, baseline) {
  if (!baseline) {
    console.log('⚠️  No baseline found. Run --save first.');
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
      // Higher is better; tolerance is a negative floor (e.g. -0.02 = allow 2% drop)
      passed = changePct >= (rule.tolerance * 100);
    } else {
      // Lower is better; tolerance is a positive ceiling (e.g. 1.20 = allow 20% increase)
      passed = changePct <= (rule.tolerance * 100 - 100);
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

function displayMetrics(metrics) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         Code-Agent Benchmark Report                  ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Tasks: ${String(metrics.totalTasks).padStart(5)} total (${metrics.completedCount} completed, ${metrics.failedCount} failed)`);
  console.log(`║  Success Rate: ${(metrics.successRate * 100).toFixed(1)}%`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  ── Duration ──');
  console.log(`║  Avg: ${String(metrics.avgDurationSec).padStart(7)}s | P50: ${String(metrics.p50DurationSec).padStart(7)}s | P90: ${String(metrics.p90DurationSec).padStart(7)}s`);
  console.log(`║  P95: ${String(metrics.p95DurationSec).padStart(7)}s | Max: ${String(metrics.maxDurationSec).padStart(7)}s`);
  console.log('║  ── Steps ──');
  console.log(`║  Avg: ${String(metrics.avgSteps).padStart(7)}   | P50: ${String(metrics.p50Steps).padStart(7)}   | P90: ${String(metrics.p90Steps).padStart(7)}`);
  console.log(`║  Max: ${String(metrics.maxSteps).padStart(7)}`);
  console.log('║  ── Tool Calls ──');
  console.log(`║  Avg: ${String(metrics.avgToolCalls).padStart(7)}   | P50: ${String(metrics.p50ToolCalls).padStart(7)}   | P90: ${String(metrics.p90ToolCalls).padStart(7)}`);
  console.log(`║  Max: ${String(metrics.maxToolCalls).padStart(7)}`);
  console.log('║  ── Efficiency ──');
  console.log(`║  Tool exec success: ${(metrics.toolExecSuccessRate * 100).toFixed(1)}% | Avg calls/step: ${metrics.avgToolCallsPerStep}`);
  console.log(`║  Avg step duration: ${metrics.avgStepDurationMs}ms (sampled ${metrics.sampledTaskCount} tasks)`);
  console.log('║  ── Tool Usage (sampled) ──');
  const tools = Object.entries(metrics.toolUsageDistribution || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);
  for (const [name, count] of tools) {
    console.log(`║  ${name.padEnd(20)} ${String(count).padStart(6)} calls`);
  }
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

function displayComparison(result) {
  if (result.isNew) return;
  
  console.log('\n╔══════════════════════════════════════════════════════╗');
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

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const mode = args[0] || '';

async function main() {
  const metrics = computeMetrics();
  if (!metrics) process.exit(1);

  if (mode === '--json') {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  if (mode === '--save') {
    const version = args[1];
    saveBaseline(metrics, version);
    displayMetrics(metrics);
    return;
  }

  if (mode === '--check') {
    const baseline = loadBaseline();
    displayMetrics(metrics);
    
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
      process.exit(1);
    }
    
    console.log('✅ Benchmark checks passed.');
    process.exit(0);
  }

  if (mode === '--summary') {
    console.log(`Tasks: ${metrics.totalTasks} | Success: ${(metrics.successRate*100).toFixed(1)}% | ` +
                `Avg: ${metrics.avgSteps} steps, ${metrics.avgToolCalls} tools, ${metrics.avgDurationSec}s`);
    return;
  }

  // Default: display
  displayMetrics(metrics);
  
  const baseline = loadBaseline();
  if (baseline) {
    const result = compareMetrics(metrics, baseline);
    displayComparison(result);
  }
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
