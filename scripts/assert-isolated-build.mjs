#!/usr/bin/env node
import path from 'node:path';

const output = process.env.H2H_NEXT_DIST_DIR;
if (process.env.H2H_RELEASE_BUILD !== '1' || !output) {
  console.error('[build] Refusing direct build. Use `npm run build` so the candidate is created in a commit/run-scoped worktree.');
  process.exit(1);
}
if (path.isAbsolute(output) || output === '.next' && !process.env.GIT_WORK_TREE && !process.cwd().includes(`${path.sep}.h2h-releases${path.sep}builds${path.sep}`)) {
  // buildCandidate uses a detached worktree below .h2h-releases/builds. Tests and
  // explicit CI callers may use another relative path, but never an absolute path.
  if (!process.cwd().includes(`${path.sep}.h2h-releases${path.sep}builds${path.sep}`)) {
    console.error(`[build] Refusing unsafe output path ${output} from ${process.cwd()}.`);
    process.exit(1);
  }
}
