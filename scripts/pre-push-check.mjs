#!/usr/bin/env node
/**
 * Code-Agent Pre-Push Guard
 * 
 * Runs benchmark comparison before allowing git push.
 * Ensures agent quality metrics haven't regressed.
 * 
 * Usage:
 *   node scripts/pre-push-check.mjs          # Run check
 *   node scripts/pre-push-check.mjs --force  # Skip check (emergency only)
 *   node scripts/pre-push-check.mjs --install # Install as git hook
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const GIT_HOOK_PATH = path.join(PROJECT_ROOT, '.git', 'hooks', 'pre-push');

const PRE_PUSH_HOOK = `#!/bin/bash
# Code-Agent Pre-Push Hook
# Automatically checks benchmark metrics before pushing.

echo ""
echo "🔍 Running Code-Agent benchmark check..."
echo ""

node "$(git rev-parse --show-toplevel)/scripts/benchmark.mjs" --check

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ Push blocked: benchmark metrics regressed."
  echo "   Review the metrics above."
  echo "   - If intentional: node scripts/benchmark.mjs --save to update baseline"
  echo "   - If emergency:  git push --no-verify"
  echo ""
  exit 1
fi

echo "✅ Benchmark check passed. Proceeding with push..."
echo ""
`;

function installHook() {
  const hooksDir = path.dirname(GIT_HOOK_PATH);
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  
  // If hook already exists, back it up
  if (fs.existsSync(GIT_HOOK_PATH)) {
    const existing = fs.readFileSync(GIT_HOOK_PATH, 'utf-8');
    if (existing.includes('Code-Agent Benchmark')) {
      console.log('✅ Pre-push hook already installed.');
      return;
    }
    const backup = GIT_HOOK_PATH + '.backup';
    fs.copyFileSync(GIT_HOOK_PATH, backup);
    console.log(`📦 Backed up existing hook to ${backup}`);
  }
  
  fs.writeFileSync(GIT_HOOK_PATH, PRE_PUSH_HOOK, { mode: 0o755 });
  console.log('✅ Pre-push hook installed at .git/hooks/pre-push');
  console.log('   Benchmark checks will run before every git push.');
}

function runCheck(force) {
  if (force) {
    console.log('⚠️  --force: skipping benchmark check');
    process.exit(0);
  }

  const benchScript = path.join(PROJECT_ROOT, 'scripts', 'benchmark.mjs');
  
  try {
    execSync(`node "${benchScript}" --check`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 30000,
    });
    process.exit(0);
  } catch (err) {
    process.exit(err.status || 1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--install')) {
  installHook();
} else if (args.includes('--force')) {
  runCheck(true);
} else {
  runCheck(false);
}
