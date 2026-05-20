#!/usr/bin/env node
/**
 * Step Limit Test Suite
 * 
 * Verifies that the step limit restriction has been removed/made unlimited.
 * Tests cover both config.yaml, standalone-demo, and the core agent config.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, message) {
	if (condition) {
		console.log(`  ✅ PASS: ${message}`);
		passed++;
	} else {
		console.error(`  ❌ FAIL: ${message}`);
		failed++;
	}
}

function assertFileNotContains(filePath, pattern, message) {
	const content = fs.readFileSync(filePath, 'utf-8');
	assert(!content.match(pattern), message);
}

function assertConfigValue(filePath, getValue, expected, message) {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const value = getValue(content);
		if (expected === 'UNLIMITED') {
			assert(value === undefined || value >= 999999, message);
		} else {
			assert(value === expected, message);
		}
	} catch (err) {
		console.error(`  ❌ FAIL: ${message} — error: ${err.message}`);
		failed++;
	}
}

console.log('\n' + '='.repeat(60));
console.log('  Step Limit Removal Test Suite');
console.log('='.repeat(60));

// ─── Test 1: config.yaml ──────────────────────────────────────────
console.log('\n📁 config.yaml tests:');

const configPath = path.join(__dirname, 'config.yaml');
assertFileNotContains(
	configPath,
	/max_steps:\s*25/,
	'config.yaml should not contain max_steps: 25 restriction'
);

// Verify config.yaml either has no max_steps or a high/unlimited value
const configContent = fs.readFileSync(configPath, 'utf-8');
const maxStepsMatch = configContent.match(/max_steps:\s*(\d+)/);
if (maxStepsMatch) {
	const val = parseInt(maxStepsMatch[1], 10);
	assert(val >= 999999, `config.yaml max_steps=${val} should be effectively unlimited (>= 999999)`);
} else {
	assert(true, 'config.yaml has no max_steps setting (will use default unlimited)');
}

// ─── Test 2: Default agent config (agentModels.ts) ────────────────
console.log('\n📁 Agent default config tests:');

const modelsPath = path.join(__dirname, 'src/vs/workbench/services/agent/common/agentModels.ts');
const modelsContent = fs.readFileSync(modelsPath, 'utf-8');
const defaultMaxStepsMatch = modelsContent.match(/maxSteps:\s*(\d+)/);
assert(
	defaultMaxStepsMatch && parseInt(defaultMaxStepsMatch[1], 10) >= 999999,
	`DEFAULT_AGENT_CONFIG.maxSteps should be >= 999999 (found: ${defaultMaxStepsMatch ? defaultMaxStepsMatch[1] : 'N/A'})`
);

// ─── Test 3: Agent run loop (agent.ts) ────────────────────────────
console.log('\n📁 Agent run loop tests:');

const agentPath = path.join(__dirname, 'src/vs/workbench/contrib/agent/common/agent.ts');
const agentContent = fs.readFileSync(agentPath, 'utf-8');

// Check that the step limit message references the config, not hardcoded 25
const limitMsgMatch = agentContent.match(/Reached the step limit/);
assert(limitMsgMatch !== null, 'agent.ts should still have step limit message for safety');

// Check it uses dynamic config value, not hardcoded 25
assert(
	!agentContent.includes('Reached the step limit (25)'),
	'agent.ts should not have hardcoded "Reached the step limit (25)"'
);

// ─── Test 4: standalone-demo (agent.mjs) ──────────────────────────
console.log('\n📁 Standalone demo tests:');

const demoPath = path.join(__dirname, 'standalone-demo/agent.mjs');
const demoContent = fs.readFileSync(demoPath, 'utf-8');
assert(
	!demoContent.includes('maxSteps: 20,'),
	'standalone-demo should not have maxSteps: 20 restriction'
);
const demoMaxStepsMatch = demoContent.match(/maxSteps:\s*(\d+)/);
assert(
	demoMaxStepsMatch && parseInt(demoMaxStepsMatch[1], 10) >= 999999,
	`standalone-demo maxSteps should be >= 999999 (found: ${demoMaxStepsMatch ? demoMaxStepsMatch[1] : 'N/A'})`
);

// ─── Test 5: Build output verification ────────────────────────────
console.log('\n📁 Build output tests:');

const buildPath = path.join(__dirname, 'build/agent-cli.js');
if (fs.existsSync(buildPath)) {
	const buildContent = fs.readFileSync(buildPath, 'utf-8');
	assert(
		!buildContent.includes('Reached the step limit (25)'),
		'Build output should not contain hardcoded "Reached the step limit (25)"'
	);
	assert(
		!buildContent.includes('Reached the step limit (20)'),
		'Build output should not contain hardcoded "Reached the step limit (20)"'
	);
	// Should still reference dynamic config value
	assert(
		buildContent.includes('Reached the step limit'),
		'Build output should still have dynamic step limit message'
	);
} else {
	console.log('  ⏭️  SKIP: build output not found (run npm run build first)');
	skipped++;
}

// ─── Summary ──────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('='.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
