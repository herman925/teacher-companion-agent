#!/usr/bin/env node
// install-hooks.mjs — point git at the project's hooks directory.
//
// If this is a git repo (a .git entry exists at the repo root), run:
//     git config core.hooksPath .githooks
// so .githooks/pre-commit and .githooks/commit-msg run on commit.
//
// If it is NOT a git repo, print a friendly note and exit 0 — never error.
// This script is invoked by `npm run hooks:install` and by the `prepare`
// lifecycle script (which `npm install` triggers), so it must be safe to run
// before `git init`.
//
// Pure Node, no dependencies. Repo root is resolved from import.meta.url.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // harness/ -> repo root

function isGitRepo() {
  // A normal repo has a .git directory; a worktree/submodule has a .git file.
  return fs.existsSync(path.join(ROOT, '.git'));
}

function main() {
  if (!isGitRepo()) {
    console.log('hooks:install — not a git repository yet.');
    console.log('  Run `git init` first, then `npm run hooks:install` to enable commit hooks.');
    process.exit(0);
  }

  const r = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (r.error) {
    console.log('hooks:install — could not run git (' + r.error.message + ').');
    console.log('  Install git, then run `npm run hooks:install`.');
    process.exit(0); // do not break `npm install`
  }

  if (r.status !== 0) {
    process.stderr.write((r.stderr || '').trim() + '\n');
    console.log('hooks:install — `git config core.hooksPath .githooks` failed (status ' + r.status + ').');
    process.exit(0); // stay non-fatal for the prepare lifecycle
  }

  console.log('✓ hooks:install — git core.hooksPath set to .githooks');
  console.log('  Active: .githooks/pre-commit (quality gate), .githooks/commit-msg (Conventional Commits).');
  console.log('  Bypass a single commit with: git commit --no-verify');
  process.exit(0);
}

main();
