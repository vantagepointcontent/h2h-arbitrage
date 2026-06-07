import fs from 'fs';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────

export interface VersionEntry {
  version: string;
  date: string;
  commit: string;
  taggedBy: string;
  notes: string;
  sections: Record<string, string[]>;
  rollbackAvailable: boolean;
}

export interface VersionHistory {
  versions: VersionEntry[];
  currentVersion: string;
  previousVersions: string[];
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface RollbackConfig {
  targetVersion: string;
  timestamp: string;
  initiatedBy: string;
  reason: string;
}

export interface ChangeLogSection {
  type: 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf' | 'chore' | 'breaking';
  message: string;
  commitHash: string;
  author: string;
  date: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');
const VERSION_HISTORY_PATH = path.join(DATA_DIR, 'version-history.json');
const MAX_ROLLBACK_SLOTS = 5;

// ─── SemVer Parsing & Comparison ────────────────────────────────────────

/** Parse a semver string into structured parts */
export function parseSemVer(version: string): SemVer | null {
  const match = version.match(/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[a-zA-Z0-9.-]+))?$/);
  if (!match?.groups) return null;
  return {
    major: parseInt(match.groups.major!, 10),
    minor: parseInt(match.groups.minor!, 10),
    patch: parseInt(match.groups.patch!, 10),
    prerelease: match.groups.prerelease,
  };
}

/** Compare two semver strings. Returns -1, 0, or 1 */
export function compareSemVer(a: string, b: string): number {
  const va = parseSemVer(a);
  const vb = parseSemVer(b);
  if (!va || !vb) return 0;
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

/** Bump a version string by the specified level */
export function bumpVersion(version: string, level: 'major' | 'minor' | 'patch'): string {
  const parsed = parseSemVer(version);
  if (!parsed) throw new Error(`Invalid version: ${version}`);
  switch (level) {
    case 'major':
      return `${parsed.major + 1}.0.0`;
    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case 'patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
}

/** Validate a version string conforms to semver */
export function isValidSemVer(version: string): boolean {
  return parseSemVer(version) !== null;
}

// ─── Version History Management ──────────────────────────────────────────

/** Read version history from disk */
export function readVersionHistory(): VersionHistory {
  try {
    const content = fs.readFileSync(VERSION_HISTORY_PATH, 'utf8');
    return JSON.parse(content);
  } catch {
    return { versions: [], currentVersion: '0.0.0', previousVersions: [] };
  }
}

/** Write version history to disk atomically */
export function writeVersionHistory(history: VersionHistory): void {
  const tmp = VERSION_HISTORY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
  fs.renameSync(tmp, VERSION_HISTORY_PATH);
}

/** Get the current version from history */
export function getCurrentVersion(): string {
  const history = readVersionHistory();
  return history.currentVersion;
}

/** Get the latest N versions */
export function getVersionEntries(limit = 10): VersionEntry[] {
  const history = readVersionHistory();
  return history.versions.slice(-limit).reverse();
}

/** Find a version entry by version string */
export function findVersion(version: string): VersionEntry | undefined {
  const history = readVersionHistory();
  return history.versions.find(v => v.version === version);
}

/** Add a new version entry */
export function addVersion(entry: VersionEntry): void {
  const history = readVersionHistory();

  // Check for duplicates
  if (history.versions.some(v => v.version === entry.version)) {
    throw new Error(`Version ${entry.version} already exists`);
  }

  // Move current version to previousVersions if it's not already there
  if (!history.previousVersions.includes(history.currentVersion)) {
    history.previousVersions.push(history.currentVersion);
  }

  // Limit previous versions to avoid unbounded growth
  if (history.previousVersions.length > MAX_ROLLBACK_SLOTS) {
    history.previousVersions = history.previousVersions.slice(-MAX_ROLLBACK_SLOTS);
  }

  history.versions.push(entry);
  history.currentVersion = entry.version;
  writeVersionHistory(history);
}

// ─── Rollback ────────────────────────────────────────────────────────────

/** Perform a rollback to a previous version */
export function rollback(config: RollbackConfig): { success: boolean; message: string; previousVersion: string; rolledBackTo: string } {
  const history = readVersionHistory();

  // Validate target version exists
  const target = history.versions.find(v => v.version === config.targetVersion);
  if (!target) {
    return {
      success: false,
      message: `Version ${config.targetVersion} not found in history`,
      previousVersion: history.currentVersion,
      rolledBackTo: '',
    };
  }

  // Check rollback availability
  if (!target.rollbackAvailable) {
    return {
      success: false,
      message: `Version ${config.targetVersion} is not available for rollback`,
      previousVersion: history.currentVersion,
      rolledBackTo: '',
    };
  }

  const previousVersion = history.currentVersion;

  // Mark the current version as still available (might need to roll back again)
  const currentEntry = history.versions.find(v => v.version === previousVersion);
  if (currentEntry) {
    currentEntry.rollbackAvailable = true;
  }

  // Update current version
  history.currentVersion = config.targetVersion;
  writeVersionHistory(history);

  return {
    success: true,
    message: `Rolled back from ${previousVersion} to ${config.targetVersion}`,
    previousVersion,
    rolledBackTo: config.targetVersion,
  };
}

/** Get available rollback targets */
export function getRollbackTargets(): VersionEntry[] {
  const history = readVersionHistory();
  return history.versions
    .filter(v => v.rollbackAvailable && v.version !== history.currentVersion)
    .sort((a, b) => compareSemVer(b.version, a.version));
}

// ─── Changelog Generation ────────────────────────────────────────────────

/**
 * Generate changelog sections from git commit messages.
 * Parses conventional commits (feat:, fix:, docs:, etc.)
 */
export function parseCommits(commits: string[]): ChangeLogSection[] {
  const sections: ChangeLogSection[] = [];
  const typeOrder: ChangeLogSection['type'][] = ['breaking', 'feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'chore'];

  for (const commit of commits) {
    // Parse conventional commit format: type(scope): message
    const match = commit.match(/^(?<type>feat|fix|docs|style|refactor|perf|chore|breaking)(?:\((?<scope>[^)]+)\))?\s*:\s*(?<message>.+)$/);
    if (!match?.groups) continue;

    const { type, message, scope } = match.groups;
    const author = commit.split('|')[1]?.trim() ?? '';
    const hash = commit.split('|')[0]?.trim() ?? '';
    const date = commit.split('|')[2]?.trim() ?? '';

    sections.push({
      type: type as ChangeLogSection['type'],
      message: scope ? `${scope}: ${message}` : message,
      commitHash: hash,
      author,
      date,
    });
  }

  // Sort by type priority
  sections.sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));
  return sections;
}

/** Group changelog sections by type */
export function groupChangeLogSections(sections: ChangeLogSection[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  const typeLabels: Record<ChangeLogSection['type'], string> = {
    feat: 'Added',
    fix: 'Fixed',
    docs: 'Documentation',
    style: 'Style',
    refactor: 'Refactored',
    perf: 'Performance',
    chore: 'Maintenance',
    breaking: 'Breaking Changes',
  };

  for (const section of sections) {
    const label = typeLabels[section.type];
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(section.message);
  }

  return grouped;
}

/** Generate a changelog entry from git log output */
export function generateChangelogEntry(
  sinceTag: string,
  untilTag: string,
  gitLogOutput: string,
): { version: string; sections: Record<string, string[]>; entries: ChangeLogSection[] } {
  const lines = gitLogOutput.trim().split('\n').filter(Boolean);
  const parsed = parseCommits(lines);
  const sections = groupChangeLogSections(parsed);

  return {
    version: untilTag,
    sections,
    entries: parsed,
  };
}

// ─── API Version Negotiation ─────────────────────────────────────────────

export interface ApiVersionInfo {
  current: string;
  supported: string[];
  deprecated: string[];
}

/**
 * API version negotiation support.
 * Returns supported API versions based on the current app version.
 */
export function getApiVersions(): ApiVersionInfo {
  const current = getCurrentVersion();
  const parsed = parseSemVer(current);
  if (!parsed) return { current, supported: [current], deprecated: [] };

  // Major version determines API compatibility
  const majorApi = `${parsed.major}.0`;
  const supported: string[] = [];

  // Current major version
  supported.push(`${parsed.major}.0`);

  // Previous major version (deprecated)
  if (parsed.major > 0) {
    supported.push(`${parsed.major - 1}.0`);
  }

  // Build deprecated list (two generations back)
  const deprecated: string[] = [];
  if (parsed.major >= 2) {
    deprecated.push(`${parsed.major - 2}.0`);
  }

  return { current, supported, deprecated };
}

/** Check if a requested API version is compatible */
export function isApiVersionCompatible(requested: string): { compatible: boolean; deprecated: boolean } {
  const apiVersions = getApiVersions();
  const reqParsed = parseSemVer(requested);
  if (!reqParsed) return { compatible: false, deprecated: false };

  const reqMajor = `${reqParsed.major}.0`;
  if (apiVersions.supported.includes(reqMajor)) {
    return { compatible: true, deprecated: apiVersions.deprecated.includes(reqMajor) };
  }
  return { compatible: false, deprecated: false };
}
