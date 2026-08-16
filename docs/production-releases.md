# Production release isolation (OPS-158)

Production Next.js artifacts are immutable releases under `.h2h-releases/`. The repository-root `.next` directory is never a build or runtime target.

## Layout

- `builds/<commit>-<run>/source`: disposable detached Git worktree used by a builder.
- `candidates/<commit>-<run>/.next`: verified candidate and its `release-manifest.json`.
- `releases/<commit>-<run>/.next`: immutable promoted release.
- `active`: atomically replaced symlink to the production release.
- `rollback`: previous known-good release.
- `locks/promotion`: exclusive promotion/rollback/cleanup lock. Builds do not take this lock.
- `events/release-events.jsonl`: promotion, rollback, cleanup, drift, and failure events.

A candidate manifest records commit, run ID, builder PID plus `/proc` start ticks, wall-clock start time, BUILD_ID, and SHA-256 inventory of required manifests and client/server chunks. Promotion rejects candidates older than the current active promotion. PID start ticks prevent PID-reuse from making a stale builder appear live.

## Commands

Build and verify a commit in its own worktree (tests, lint, Next build, and independent `dist`/`.next` output):

```sh
npm run build -- --commit <full-commit> --run-id <unique-run-id>
```

The final output line is the candidate path. Promote only that verified path:

```sh
npm run release:promote -- --candidate <candidate-path>
```

Promotion takes the exclusive lock, re-verifies every hashed asset, copies the immutable release, updates `rollback`, atomically switches `active`, restarts only `h2h-arbitrage` with `--update-env`, runs `pm2 save`, and accepts health only when `/api/health` reports the promoted commit and BUILD_ID.

On the first isolated promotion, the manager imports the existing verified root `.next` artifact as an immutable legacy release and makes it the rollback target before switching `active`. A production promotion fails closed if neither an active isolated release nor that legacy artifact can be preserved.

Rollback is one command and does not rebuild:

```sh
npm run release:rollback
```

Integrity/drift check and bounded cleanup:

```sh
npm run release:verify
npm run release:cleanup -- --keep 4
```

Cleanup holds the promotion lock, preserves `active` and `rollback`, keeps four additional releases by default, and removes only expired candidates whose exact builder PID identity is no longer live. Candidate builds continue concurrently because they never take the promotion lock.

## Failure and alert behavior

- A failed test, lint, or build deletes only that run's staging worktree.
- A missing manifest/chunk, BUILD_ID directory, commit mismatch, or hash drift fails closed.
- An interrupted promotion before the atomic symlink rename leaves the old active release visible.
- PM2 startup calls `release-manager.mjs verify-active` before opening port 3000.
- CLI failures and integrity drift append an `alert` event and exit non-zero; operations monitoring should alert on a non-zero `release:verify` run and on `"type":"alert"` in the event log.
- PM2 runs `h2h-release-monitor` continuously at a 60-second interval. It emits a deduplicated error-log alert/event for missing manifests, chunks, mixed identity, or unexpected active mutations and a recovery event when integrity returns.
- `--no-restart` is rejected unless `H2H_RELEASE_TEST_MODE=1`, preventing an operator from reporting promotion complete without runtime verification.
- `--skip-tests` is also test-mode-only. Production promotion requires the candidate manifest to record passing tests and lint.

## Retention and scheduler

PM2 supplies the minute-by-minute integrity monitor. Run `npm run release:cleanup -- --keep 4` daily from the host scheduler and alert on any non-zero exit. Never use `rm -rf .next`, invoke `next build` as a deployment step, or manually move artifacts into the active release.
