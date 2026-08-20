import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const DEFAULT_EVIDENCE_ROOT = '/home/scott/h2h-evidence';
export const MANIFEST_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DELIVERY_STATES = new Set(['pending', 'delivered', 'not-applicable']);

function assertId(label, value) {
  if (!ID_PATTERN.test(String(value ?? ''))) throw new Error(`${label} must match ${ID_PATTERN}`);
  return String(value);
}

function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const staging = `${filePath}.staging.${process.pid}.${randomUUID()}`;
  const fd = openSync(staging, 'wx', 0o640);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, filePath);
}

export function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function hashFile(filePath) {
  return sha256File(filePath);
}

function statIdentity(filePath) {
  const stat = statSync(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error(`Evidence source is not a regular file: ${filePath}`);
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    sizeBytes: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.sizeBytes === right.sizeBytes
    && left.mtimeNs === right.mtimeNs;
}

function manifestPaths(root, taskId, evidenceId) {
  const safeTaskId = assertId('taskId', taskId);
  const safeEvidenceId = assertId('evidenceId', evidenceId);
  const directory = path.join(path.resolve(root), safeTaskId, safeEvidenceId);
  return {
    directory,
    manifestPath: path.join(directory, 'manifest.json'),
    manifestHashPath: path.join(directory, 'manifest.sha256'),
  };
}

function writeManifest(paths, manifest) {
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  atomicWrite(paths.manifestPath, body);
  atomicWrite(paths.manifestHashPath, `${createHash('sha256').update(body).digest('hex')}  manifest.json\n`);
}

export function registerEvidence({
  sourcePath,
  taskId,
  evidenceId,
  kind = 'recovery',
  ownerProfile = null,
  root = process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT,
  deliveryState = 'pending',
  expiresAt = null,
  now = new Date(),
}) {
  if (!DELIVERY_STATES.has(deliveryState)) throw new Error(`Invalid delivery state: ${deliveryState}`);
  const source = path.resolve(sourcePath);
  const before = statIdentity(source);
  const paths = manifestPaths(root, taskId, evidenceId);
  if (existsSync(paths.directory)) throw new Error(`Evidence ID already exists: ${taskId}/${evidenceId}`);
  mkdirSync(paths.directory, { recursive: true, mode: 0o750 });
  const payloadName = path.basename(source);
  const payloadPath = path.join(paths.directory, payloadName);
  const staging = `${payloadPath}.staging.${process.pid}.${randomUUID()}`;
  let payloadSha256;
  try {
    const sourceSha256 = hashFile(source);
    const afterSourceHash = statIdentity(source);
    if (!sameIdentity(before, afterSourceHash)) throw new Error(`Evidence source changed while hashing: ${source}`);
    copyFileSync(source, staging);
    const stagingFd = openSync(staging, 'r');
    try { fsyncSync(stagingFd); } finally { closeSync(stagingFd); }
    const afterCopy = statIdentity(source);
    if (!sameIdentity(before, afterCopy)) throw new Error(`Evidence source changed while copying: ${source}`);
    payloadSha256 = hashFile(staging);
    if (sourceSha256 !== payloadSha256) throw new Error(`Evidence copy hash mismatch: ${source}`);
    renameSync(staging, payloadPath);
  } catch (error) {
    try { unlinkSync(staging); } catch {}
    throw error;
  }

  const createdAt = now.toISOString();
  const manifest = {
    version: MANIFEST_VERSION,
    evidenceId: String(evidenceId),
    kind,
    state: 'present',
    protected: true,
    payload: {
      path: payloadPath,
      fileName: payloadName,
      sizeBytes: before.sizeBytes,
      sha256: payloadSha256,
    },
    source: { path: source, ...before },
    owner: {
      taskId: String(taskId),
      profile: ownerProfile || process.env.HERMES_PROFILE || 'unknown',
      pid: process.pid,
    },
    delivery: { state: deliveryState, deliveredAt: null, reference: null },
    retention: { expiresAt },
    createdAt,
    lastVerifiedAt: createdAt,
  };
  writeManifest(paths, manifest);
  return { ...manifest, manifestPath: paths.manifestPath, manifestHashPath: paths.manifestHashPath };
}

export function recordIrrecoverableEvidence({
  taskId,
  evidenceId,
  expectedPath,
  kind = 'recovery',
  ownerProfile = null,
  reason,
  root = process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT,
  now = new Date(),
}) {
  if (!reason) throw new Error('Irrecoverable evidence requires a reason');
  const paths = manifestPaths(root, taskId, evidenceId);
  if (existsSync(paths.directory)) throw new Error(`Evidence ID already exists: ${taskId}/${evidenceId}`);
  mkdirSync(paths.directory, { recursive: true, mode: 0o750 });
  const recordedAt = now.toISOString();
  const manifest = {
    version: MANIFEST_VERSION,
    evidenceId: String(evidenceId),
    kind,
    state: 'irrecoverable',
    protected: true,
    payload: null,
    source: { path: path.resolve(expectedPath) },
    owner: {
      taskId: String(taskId),
      profile: ownerProfile || process.env.HERMES_PROFILE || 'unknown',
      pid: process.pid,
    },
    delivery: { state: 'not-applicable', deliveredAt: null, reference: null },
    retention: { expiresAt: null },
    loss: { reason, recordedAt },
    createdAt: recordedAt,
    lastVerifiedAt: null,
  };
  writeManifest(paths, manifest);
  return { ...manifest, manifestPath: paths.manifestPath, manifestHashPath: paths.manifestHashPath };
}

export function readManifest({ root = process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT, taskId, evidenceId }) {
  const paths = manifestPaths(root, taskId, evidenceId);
  const body = readFileSync(paths.manifestPath, 'utf8');
  const expectedManifestHash = readFileSync(paths.manifestHashPath, 'utf8').trim().split(/\s+/)[0];
  const actualManifestHash = createHash('sha256').update(body).digest('hex');
  if (actualManifestHash !== expectedManifestHash) throw new Error(`Manifest hash mismatch: ${paths.manifestPath}`);
  const manifest = JSON.parse(body);
  if (manifest.version !== MANIFEST_VERSION || manifest.protected !== true) {
    throw new Error(`Manifest is not a supported protected-evidence record: ${paths.manifestPath}`);
  }
  return { manifest, ...paths, manifestSha256: actualManifestHash };
}

export function verifyEvidence(options) {
  const record = readManifest(options);
  const { manifest } = record;
  if (manifest.state === 'irrecoverable') {
    return { preserved: false, current: true, state: 'irrecoverable', reason: manifest.loss?.reason ?? 'unknown', ...record };
  }
  const payloadPath = manifest.payload?.path;
  if (!payloadPath || !existsSync(payloadPath)) {
    return { preserved: false, current: true, state: 'missing', reason: 'payload-absent', ...record };
  }
  const stat = statIdentity(payloadPath);
  const sha256 = hashFile(payloadPath);
  const preserved = stat.sizeBytes === manifest.payload.sizeBytes && sha256 === manifest.payload.sha256;
  return {
    preserved,
    current: true,
    state: preserved ? 'verified' : 'corrupt',
    checkedAt: new Date().toISOString(),
    actual: { sizeBytes: stat.sizeBytes, sha256 },
    ...record,
  };
}

export function markDelivered({
  root = process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT,
  taskId,
  evidenceId,
  reference,
  now = new Date(),
}) {
  if (!reference) throw new Error('Delivery reference is required');
  const record = readManifest({ root, taskId, evidenceId });
  if (record.manifest.state !== 'present') throw new Error('Cannot deliver missing or irrecoverable evidence');
  const verification = verifyEvidence({ root, taskId, evidenceId });
  if (!verification.preserved) throw new Error(`Cannot deliver unverified evidence: ${verification.state}`);
  record.manifest.delivery = { state: 'delivered', deliveredAt: now.toISOString(), reference };
  record.manifest.lastVerifiedAt = verification.checkedAt;
  writeManifest(record, record.manifest);
  return record.manifest;
}

export function evaluateEvidenceDeletion({
  root = process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT,
  taskId,
  evidenceId,
  now = new Date(),
}) {
  let record;
  try {
    record = readManifest({ root, taskId, evidenceId });
  } catch (error) {
    return { allowed: false, reason: `manifest-unreadable:${error instanceof Error ? error.message : String(error)}` };
  }
  const { manifest } = record;
  if (manifest.protected === true) return { allowed: false, reason: 'protected-evidence' };
  if (manifest.delivery?.state !== 'delivered') return { allowed: false, reason: 'delivery-incomplete' };
  if (!manifest.retention?.expiresAt) return { allowed: false, reason: 'retention-expiry-missing' };
  if (Date.parse(manifest.retention.expiresAt) > now.getTime()) return { allowed: false, reason: 'retention-not-expired' };
  const verification = verifyEvidence({ root, taskId, evidenceId });
  if (!verification.preserved) return { allowed: false, reason: `verification-failed:${verification.state}` };
  return { allowed: true, reason: 'eligible' };
}

export function isInsideManagedEvidence(candidatePath, root = process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT) {
  const resolvedRoot = path.resolve(root);
  let resolvedCandidate = path.resolve(candidatePath);
  try { resolvedCandidate = realpathSync.native(resolvedCandidate); } catch {}
  let canonicalRoot = resolvedRoot;
  try { canonicalRoot = realpathSync.native(resolvedRoot); } catch {}
  return resolvedCandidate === canonicalRoot || resolvedCandidate.startsWith(`${canonicalRoot}${path.sep}`);
}
