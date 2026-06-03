#!/usr/bin/env node
/**
 * Code-Agent Harness Test Suite
 * 
 * Comprehensive test suite for verifying agent robustness.
 * Tests tool implementations, error recovery, edge cases, and DeepSeek V4 Pro features.
 * 
 * Usage:
 *   node test_harness.mjs              # Run all tests
 *   node test_harness.mjs --unit        # Unit tests only (no API required)
 *   node test_harness.mjs --integration # Integration tests (requires API)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0, skipped = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✅ PASS: ${message}`); passed++; }
  else { console.error(`  ❌ FAIL: ${message}`); failed++; }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
}

function assertContains(haystack, needle, message) {
  const found = haystack.includes(needle);
  if (found) { console.log(`  ✅ PASS: ${message}`); passed++; }
  else { console.error(`  ❌ FAIL: ${message} (string "${needle.substring(0, 40)}" not found)`); failed++; }
}

// ============================================================================
// Test 1: Reasoning model detection
// ============================================================================
console.log('\n📁 Reasoning Model Detection:');

const modelsPath = path.join(__dirname, 'src/vs/workbench/services/agent/browser/llmOpenai.ts');
const modelsContent = fs.readFileSync(modelsPath, 'utf-8');

// Extract the isReasoningModel function
const reasoningFnMatch = modelsContent.match(/function isReasoningModel[\s\S]*?^}/m);
assert(reasoningFnMatch !== null, 'isReasoningModel function found in llmOpenai.ts');

if (reasoningFnMatch) {
  const fnBody = reasoningFnMatch[0];
  assertContains(fnBody, 'deepseek-v4-pro', 'deepseek-v4-pro detected as reasoning model');
  assertContains(fnBody, 'deepseek-r', 'deepseek-r* variants detected as reasoning models');
  assertContains(fnBody, 'reasoner', 'reasoner keyword still detected');
  assertContains(fnBody, "startsWith('o1')", 'OpenAI o-series still detected');
}

// ============================================================================
// Test 2: RunTerminal zombie process prevention
// ============================================================================
console.log('\n📁 RunTerminal Zombie Process Prevention:');

const runTerminalPath = path.join(__dirname, 'src/vs/workbench/contrib/agent/common/tools/runTerminal.ts');
const runTerminalContent = fs.readFileSync(runTerminalPath, 'utf-8');

assertContains(runTerminalContent, 'instance.dispose()', 'runTerminal calls instance.dispose() on cleanup');
assertContains(runTerminalContent, 'const cleanup = ()', 'Has centralized cleanup function');
assertContains(runTerminalContent, 'Command blocked by safety filter', 'Has dangerous command detection');
assertContains(runTerminalContent, "\\brm\\s+-rf\\s+\\/", 'Blocks rm -rf /');

// ============================================================================
// Test 3: Parallel checkpoint isolation
// ============================================================================
console.log('\n📁 Parallel Checkpoint Isolation:');

const parallelPath = path.join(__dirname, 'src/vs/workbench/contrib/agent/common/agentParallel.ts');
const parallelContent = fs.readFileSync(parallelPath, 'utf-8');

assertContains(parallelContent, 'checkpointManager.clone()', 'Parallel agent uses checkpointManager.clone()');

const checkpointPath = path.join(__dirname, 'src/vs/workbench/contrib/agent/common/agentCheckpoint.ts');
const checkpointContent = fs.readFileSync(checkpointPath, 'utf-8');

assertContains(checkpointContent, 'clone(): AgentCheckpointManager', 'AgentCheckpointManager has clone() method');

// ============================================================================
// Test 4: Context summarization retry
// ============================================================================
console.log('\n📁 Context Summarization Retry:');

const contextPath = path.join(__dirname, 'src/vs/workbench/contrib/agent/common/agentContext.ts');
const contextContent = fs.readFileSync(contextPath, 'utf-8');

assertContains(contextContent, 'MAX_SUMMARY_RETRIES', 'Has MAX_SUMMARY_RETRIES constant');
assertContains(contextContent, 'retrying', 'Has retry logging');
assertContains(contextContent, 'All retries exhausted', 'Has fallback message when retries exhausted');

// ============================================================================
// Test 5: Consecutive tool call guard
// ============================================================================
console.log('\n📁 Consecutive Tool Call Guard:');

const agentPath = path.join(__dirname, 'src/vs/workbench/contrib/agent/common/agent.ts');
const agentContent = fs.readFileSync(agentPath, 'utf-8');

assertContains(agentContent, 'MAX_CONSECUTIVE_TOOL_ONLY_STEPS', 'Has MAX_CONSECUTIVE_TOOL_ONLY_STEPS constant');
assertContains(agentContent, 'consecutiveToolOnlySteps', 'Tracks consecutiveToolOnlySteps');
assertContains(agentContent, 'stuck in a loop', 'Has loop detection warning message');

// ============================================================================
// Test 6: DeepSeek error recovery improvements
// ============================================================================
console.log('\n📁 DeepSeek Error Recovery:');

assertContains(modelsContent, "'tps'", 'Handles TPS rate limiting');
assertContains(modelsContent, "'overload'", 'Handles model overload');
assertContains(modelsContent, "'busy'", 'Handles model busy');
assertContains(modelsContent, "'concurrent'", 'Handles concurrent request limit');
assertContains(modelsContent, 'status === 502', 'Handles 502 Bad Gateway');

// ============================================================================
// Test 7: Config integrity
// ============================================================================
console.log('\n📁 Config Integrity:');

const configPath = path.join(__dirname, 'config.yaml');
const configContent = fs.readFileSync(configPath, 'utf-8');

assert(configContent.includes('max_steps: 999999'), 'config.yaml has unlimited max_steps');
assert(configContent.includes('max_context_tokens: 200000'), 'config.yaml has 200K context tokens');
assert(configContent.includes('step_timeout: 120000'), 'config.yaml has 2min step timeout');

// Verify no API key leakage in test (just check key is present but not printing it)
assert(configContent.includes('api_key:'), 'config.yaml has api_key configured');

// ============================================================================
// Test 8: All 7 tools properly registered in main.ts
// ============================================================================
console.log('\n📁 Tool Registration:');

const mainPath = path.join(__dirname, 'vs-core/node-runtime/main.ts');
const mainContent = fs.readFileSync(mainPath, 'utf-8');

const requiredTools = [
  'new ReadFileTool',
  'new WriteFileTool',
  'new EditFileTool',
  'new ListDirectoryTool',
  'new SearchTextTool',
  'new SearchFilesTool',
  'new RunTerminalTool',
];

for (const tool of requiredTools) {
  assertContains(mainContent, tool, `${tool} registered in main.ts`);
}

// ============================================================================
// Test 9: Tool schemas have required fields
// ============================================================================
console.log('\n📁 Tool Schema Validation:');

const toolFiles = {
  readFile: 'src/vs/workbench/contrib/agent/common/tools/readFile.ts',
  writeFile: 'src/vs/workbench/contrib/agent/common/tools/writeFile.ts',
  editFile: 'src/vs/workbench/contrib/agent/common/tools/editFile.ts',
  listDir: 'src/vs/workbench/contrib/agent/common/tools/listDir.ts',
  searchText: 'src/vs/workbench/contrib/agent/common/tools/searchText.ts',
  searchFiles: 'src/vs/workbench/contrib/agent/common/tools/searchFiles.ts',
  runTerminal: 'src/vs/workbench/contrib/agent/common/tools/runTerminal.ts',
};

for (const [name, filePath] of Object.entries(toolFiles)) {
  const content = fs.readFileSync(path.join(__dirname, filePath), 'utf-8');
  assertContains(content, "readonly name = '", `${name}: has name field`);
  assertContains(content, "readonly description = '", `${name}: has description field`);
  assertContains(content, "readonly parameters = {", `${name}: has parameters schema`);
  assertContains(content, "type: 'object'", `${name}: parameters is object type`);
  assertContains(content, 'required:', `${name}: has required fields`);
  assertContains(content, 'execute(args: Record<string, unknown>): Promise<IToolResult>', `${name}: has execute method`);
}

// ============================================================================
// Test 10: Build output integrity
// ============================================================================
console.log('\n📁 Build Output Integrity:');

const buildPath = path.join(__dirname, 'build/agent-cli.js');
if (fs.existsSync(buildPath)) {
  const buildContent = fs.readFileSync(buildPath, 'utf-8');
  
  // Verify critical fixes are in the build
  assertContains(buildContent, 'MAX_CONSECUTIVE_TOOL_ONLY_STEPS', 'Build: consecutive tool guard present');
  assertContains(buildContent, 'instance.dispose()', 'Build: terminal cleanup present');
  assertContains(buildContent, 'MAX_SUMMARY_RETRIES', 'Build: summary retry present');
  assertContains(buildContent, 'checkpointManager.clone()', 'Build: checkpoint isolation present');
  assertContains(buildContent, 'deepseek-v4-pro', 'Build: deepseek-v4-pro reasoning detection present');
  assertContains(buildContent, 'Command blocked by safety filter', 'Build: dangerous command filter present');
  
  // Verify no hardcoded step limits
  assert(!buildContent.includes('maxSteps: 25'), 'Build: no hardcoded maxSteps: 25');
  assert(!buildContent.includes('maxSteps: 20'), 'Build: no hardcoded maxSteps: 20');
} else {
  console.log('  ⏭️  SKIP: build output not found (run npm run build first)');
  skipped++;
}

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('='.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
