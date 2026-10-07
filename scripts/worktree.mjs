// Makes a worktree runnable and previewable, the same as the main checkout.
//
//   npm run worktree        (in a worktree, or in the main checkout)
//
// In a worktree (.claude/worktrees/<name>):
//   - links .dev.vars and .dev.vars.test to the main checkout's (gitignored,
//     so a new worktree has neither and `npm run dev` stops);
//   - installs node_modules if there are none;
//   - copies the main checkout's local D1 (the Gmail connection and settings
//     come with it) if it has none, then applies this branch's migrations.
// Anything already there is left as it is, so it's safe to re-run.
//
// Then, wherever it runs, it writes the main checkout's .claude/launch.json:
// "dev" for the main checkout and "dev:<name>" for each worktree. The
// desktop app's preview reads launch.json from the folder the session was
// opened in (the main checkout) and runs there, so a worktree is only
// previewable through an entry whose `cwd` points into it. Generated, not
// tracked: it changes with every worktree.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const here = git('rev-parse', '--show-toplevel');
const main = dirname(resolve(here, git('rev-parse', '--git-common-dir')));
const worktrees = join(main, '.claude', 'worktrees');

if (here !== main) {
  for (const file of ['.dev.vars', '.dev.vars.test']) {
    const link = join(here, file);
    if (existsOrLink(link)) continue;
    if (!existsSync(join(main, file))) {
      console.warn(`${file}: the main checkout has none (README → Test CRM).`);
      continue;
    }
    symlinkSync(relative(here, join(main, file)), link);
    console.log(`${file} → the main checkout's`);
  }

  if (!existsSync(join(here, 'node_modules'))) run('npm', ['ci'], here);

  const state = join('.wrangler', 'state');
  if (!existsSync(join(here, state)) && existsSync(join(main, state))) {
    cpSync(join(main, state), join(here, state), { recursive: true });
    console.log('local D1: copied from the main checkout');
  }
  run('npm', ['run', 'db:migrate:local'], here);
}

const dev = (name, cwd) => ({
  name,
  ...(cwd ? { cwd } : {}),
  runtimeExecutable: 'sh',
  runtimeArgs: ['-c', 'npm run dev -- --port ${PORT:-8787}'],
  port: 8787,
  autoPort: true,
});

const names = existsSync(worktrees)
  ? readdirSync(worktrees)
      .filter((name) => existsSync(join(worktrees, name, 'package.json')))
      .sort()
  : [];
const launch = {
  version: '0.0.1',
  configurations: [dev('dev'), ...names.map((name) => dev(`dev:${name}`, `.claude/worktrees/${name}`))],
};
writeFileSync(join(main, '.claude', 'launch.json'), JSON.stringify(launch, null, 2) + '\n');
console.log(`launch.json: dev${names.map((n) => `, dev:${n}`).join('')}`);

function existsOrLink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
