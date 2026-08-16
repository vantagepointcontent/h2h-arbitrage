import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const created: string[] = [];
const execFileAsync = promisify(execFile);

async function manager() {
  return import(pathToFileURL(path.join(process.cwd(), 'scripts', 'release-manager.mjs')).href);
}

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'h2h-release-test-'));
  created.push(value);
  return value;
}

async function artifact(base: string, commit: string, buildId: string) {
  const dir = path.join(base, `${commit}-${buildId}`);
  await mkdir(path.join(dir, 'static', buildId), { recursive: true });
  await mkdir(path.join(dir, 'static', 'chunks'), { recursive: true });
  await mkdir(path.join(dir, 'server', 'chunks'), { recursive: true });
  await writeFile(path.join(dir, 'BUILD_ID'), `${buildId}\n`);
  await writeFile(path.join(dir, 'DEPLOY_COMMIT'), `${commit}\n`);
  await writeFile(path.join(dir, 'build-manifest.json'), JSON.stringify({ pages: { '/': ['static/chunks/app.js'] } }));
  await writeFile(path.join(dir, 'routes-manifest.json'), JSON.stringify({ version: 3 }));
  await writeFile(path.join(dir, 'prerender-manifest.json'), JSON.stringify({ version: 4 }));
  await writeFile(path.join(dir, 'required-server-files.json'), JSON.stringify({ version: 1, files: ['server/chunks/runtime.js'] }));
  await writeFile(path.join(dir, 'ragnar-consumer.mjs'), 'export {};\n');
  await writeFile(path.join(dir, 'static', buildId, '_buildManifest.js'), `self.__BUILD=${JSON.stringify(buildId)}`);
  await writeFile(path.join(dir, 'static', 'chunks', 'app.js'), `self.__COMMIT=${JSON.stringify(commit)}`);
  await writeFile(path.join(dir, 'server', 'chunks', 'runtime.js'), `exports.commit=${JSON.stringify(commit)}`);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isolated production releases', () => {
  it('routes every canonical build, runtime, verification, and cleanup entry point through release isolation', async () => {
    const repo = process.cwd();
    const [packageJson, nextConfig, startApp, verifier, health, ecosystem] = await Promise.all([
      readFile(path.join(repo, 'package.json'), 'utf8'),
      readFile(path.join(repo, 'next.config.ts'), 'utf8'),
      readFile(path.join(repo, 'scripts', 'start-app.sh'), 'utf8'),
      readFile(path.join(repo, 'scripts', 'verify-ticket.sh'), 'utf8'),
      readFile(path.join(repo, 'src', 'app', 'api', 'health', 'route.ts'), 'utf8'),
      readFile(path.join(repo, 'ecosystem.config.js'), 'utf8'),
    ]);
    expect(JSON.parse(packageJson).scripts.build).toContain('release-manager.mjs build');
    expect(JSON.parse(packageJson).scripts['build:raw']).toContain('build:ragnar');
    expect(nextConfig).toContain('H2H_NEXT_DIST_DIR');
    expect(nextConfig).not.toMatch(/distDir:\s*['"]\.next['"]/);
    expect(startApp).toContain('release-manager.mjs verify-active');
    expect(startApp).toContain('H2H_NEXT_DIST_DIR=.h2h-releases/active/.next');
    expect(verifier).toContain('release-manager.mjs build');
    expect(health).toContain('deployment:');
    expect(health).toContain('H2H_BUILD_ID');
    expect(ecosystem).toContain("name: 'h2h-release-monitor'");
    expect(ecosystem).toContain("script: './.h2h-releases/active/.next/ragnar-consumer.mjs'");
  });

  it('materializes dependencies inside the detached build worktree instead of using an external symlink', async () => {
    const api = await manager();
    const repo = await root();
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Release Test'], { cwd: repo });
    await writeFile(path.join(repo, 'package.json'), '{"private":true}\n');
    await execFileAsync('git', ['add', 'package.json'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const commit = stdout.trim();
    await mkdir(path.join(repo, 'node_modules', 'fixture-package'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'fixture-package', 'marker'), 'present\n');
    const bin = path.join(repo, 'test-bin');
    await mkdir(bin);
    const fakeNpm = path.join(bin, 'npm');
    await writeFile(fakeNpm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dependencies = path.join(process.cwd(), 'node_modules');
if (!fs.statSync(dependencies).isDirectory() || fs.lstatSync(dependencies).isSymbolicLink()) process.exit(42);
if (!fs.existsSync(path.join(dependencies, 'fixture-package', 'marker'))) process.exit(43);
for (const relative of ['static/build-test', 'static/chunks', 'server/chunks']) fs.mkdirSync(path.join('.next', relative), { recursive: true });
for (const file of ['build-manifest.json', 'routes-manifest.json', 'prerender-manifest.json', 'required-server-files.json']) fs.writeFileSync(path.join('.next', file), '{}');
fs.writeFileSync(path.join('.next', 'BUILD_ID'), 'build-test\\n');
fs.writeFileSync(path.join('.next', 'ragnar-consumer.mjs'), 'export {};\\n');
fs.writeFileSync(path.join('.next', 'static', 'chunks', 'app.js'), 'app');
fs.writeFileSync(path.join('.next', 'server', 'chunks', 'runtime.js'), 'runtime');
`);
    await chmod(fakeNpm, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      await expect(api.buildCandidate({ repoRoot: repo, commit, runId: 'dependency-copy', skipTests: true }))
        .resolves.toContain(`${commit}-dependency-copy`);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('keeps concurrent candidates and cleanup isolated from the active artifact', async () => {
    const api = await manager();
    const repo = await root();
    const first = await artifact(repo, 'a'.repeat(40), 'build-a');
    const second = await artifact(repo, 'b'.repeat(40), 'build-b');

    const [candidateA, candidateB] = await Promise.all([
      api.sealCandidate({ repoRoot: repo, artifactDir: first, commit: 'a'.repeat(40), runId: 'run-a' }),
      api.sealCandidate({ repoRoot: repo, artifactDir: second, commit: 'b'.repeat(40), runId: 'run-b' }),
    ]);
    await api.promoteRelease({ repoRoot: repo, candidateDir: candidateA, restart: false });
    const activeBefore = await api.readActiveIdentity(repo);

    await Promise.all([
      api.cleanupReleases({ repoRoot: repo, now: Date.now() + 86_400_000, candidateMaxAgeMs: 1 }),
      api.verifyRelease(candidateA),
      api.verifyRelease(candidateB),
    ]);

    expect(await api.readActiveIdentity(repo)).toEqual(activeBefore);
    expect((await api.verifyRelease(candidateA)).commit).toBe('a'.repeat(40));
    expect((await api.verifyRelease(candidateB)).commit).toBe('b'.repeat(40));
  });

  it('atomically promotes, fences stale builders, survives interrupted promotion, and rolls back without rebuilding', async () => {
    const api = await manager();
    const repo = await root();
    const oldArtifact = await artifact(repo, '1'.repeat(40), 'old-build');
    const newArtifact = await artifact(repo, '2'.repeat(40), 'new-build');
    const staleArtifact = await artifact(repo, '3'.repeat(40), 'stale-build');
    const oldCandidate = await api.sealCandidate({ repoRoot: repo, artifactDir: oldArtifact, commit: '1'.repeat(40), runId: 'old' });
    await api.promoteRelease({ repoRoot: repo, candidateDir: oldCandidate, restart: false });
    const staleCandidate = await api.sealCandidate({ repoRoot: repo, artifactDir: staleArtifact, commit: '3'.repeat(40), runId: 'stale', startedAt: '2000-01-01T00:00:00.000Z' });
    const newCandidate = await api.sealCandidate({ repoRoot: repo, artifactDir: newArtifact, commit: '2'.repeat(40), runId: 'new' });

    await expect(api.promoteRelease({ repoRoot: repo, candidateDir: staleCandidate, restart: false })).rejects.toThrow(/stale candidate/i);
    await expect(api.promoteRelease({
      repoRoot: repo,
      candidateDir: newCandidate,
      restart: false,
      beforeSwitch: () => { throw new Error('interrupted'); },
    })).rejects.toThrow('interrupted');
    expect((await api.readActiveIdentity(repo)).buildId).toBe('old-build');

    await api.promoteRelease({ repoRoot: repo, candidateDir: newCandidate, restart: false });
    expect((await api.readActiveIdentity(repo)).buildId).toBe('new-build');
    await api.rollbackRelease({ repoRoot: repo, restart: false });
    expect((await api.readActiveIdentity(repo)).buildId).toBe('old-build');
  });

  it('rejects missing chunks, mixed commit assets, and unexpected active mutations', async () => {
    const api = await manager();
    const repo = await root();
    const broken = await artifact(repo, '4'.repeat(40), 'broken-build');
    const { rm } = await import('node:fs/promises');
    await rm(path.join(broken, 'static', 'chunks', 'app.js'));
    await expect(api.sealCandidate({ repoRoot: repo, artifactDir: broken, commit: '4'.repeat(40), runId: 'broken' })).rejects.toThrow(/missing/i);

    const mixed = await artifact(repo, '5'.repeat(40), 'mixed-build');
    await writeFile(path.join(mixed, 'DEPLOY_COMMIT'), `${'6'.repeat(40)}\n`);
    await expect(api.sealCandidate({ repoRoot: repo, artifactDir: mixed, commit: '5'.repeat(40), runId: 'mixed' })).rejects.toThrow(/commit/i);

    const valid = await artifact(repo, '7'.repeat(40), 'valid-build');
    const candidate = await api.sealCandidate({ repoRoot: repo, artifactDir: valid, commit: '7'.repeat(40), runId: 'valid' });
    await api.promoteRelease({ repoRoot: repo, candidateDir: candidate, restart: false });
    const activeLink = path.join(repo, '.h2h-releases', 'active');
    const active = path.resolve(path.dirname(activeLink), await readFile(activeLink, 'utf8').catch(async () => ''));
    const identity = await api.readActiveIdentity(repo);
    const target = identity.releaseDir ?? active;
    await writeFile(path.join(target, '.next', 'static', 'chunks', 'app.js'), 'mutated');
    await expect(api.verifyActiveRelease(repo)).rejects.toThrow(/drift|integrity/i);
  });

  it('serializes promotion against cleanup while leaving the prior active release readable', async () => {
    const api = await manager();
    const repo = await root();
    const first = await artifact(repo, '8'.repeat(40), 'lock-old');
    const firstCandidate = await api.sealCandidate({ repoRoot: repo, artifactDir: first, commit: '8'.repeat(40), runId: 'lock-old' });
    await api.promoteRelease({ repoRoot: repo, candidateDir: firstCandidate, restart: false });
    const second = await artifact(repo, '9'.repeat(40), 'lock-new');
    const secondCandidate = await api.sealCandidate({ repoRoot: repo, artifactDir: second, commit: '9'.repeat(40), runId: 'lock-new' });

    let releasePromotion!: () => void;
    let promotionLocked!: () => void;
    const locked = new Promise<void>((resolve) => { promotionLocked = resolve; });
    const hold = new Promise<void>((resolve) => { releasePromotion = resolve; });
    const promotion = api.promoteRelease({
      repoRoot: repo,
      candidateDir: secondCandidate,
      restart: false,
      beforeSwitch: async () => { promotionLocked(); await hold; },
    });
    await locked;
    expect((await api.readActiveIdentity(repo)).buildId).toBe('lock-old');
    await expect(api.cleanupReleases({ repoRoot: repo })).rejects.toThrow(/promotion lock/i);
    releasePromotion();
    await promotion;
    expect((await api.readActiveIdentity(repo)).buildId).toBe('lock-new');
  });

  it('imports the pre-isolation production artifact as the first rollback target', async () => {
    const api = await manager();
    const repo = await root();
    await artifact(repo, 'c'.repeat(40), 'legacy-build').then((source) =>
      import('node:fs/promises').then(({ rename }) => rename(source, path.join(repo, '.next'))));
    const fresh = await artifact(repo, 'd'.repeat(40), 'fresh-build');
    const candidate = await api.sealCandidate({ repoRoot: repo, artifactDir: fresh, commit: 'd'.repeat(40), runId: 'fresh' });

    await api.promoteRelease({ repoRoot: repo, candidateDir: candidate, restart: false });
    expect((await api.readActiveIdentity(repo)).buildId).toBe('fresh-build');
    await api.rollbackRelease({ repoRoot: repo, restart: false });
    expect((await api.readActiveIdentity(repo)).buildId).toBe('legacy-build');
  });
});
