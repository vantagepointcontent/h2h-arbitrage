import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function leaseName(marketId) {
  return createHash('sha256').update(String(marketId)).digest('hex');
}

async function readLease(leasePath) {
  try {
    return JSON.parse(await readFile(path.join(leasePath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function createLease(leasePath, ownerId, ttlMs, now) {
  const stagingPath = `${leasePath}.staging.${process.pid}.${randomUUID()}`;
  await mkdir(stagingPath);
  const lease = {
    path: leasePath,
    ownerId,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  try {
    await writeFile(path.join(stagingPath, 'owner.json'), JSON.stringify(lease));
    await rename(stagingPath, leasePath);
    return lease;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

export async function acquireMarketLease(directory, marketId, ownerId, ttlMs, now = Date.now()) {
  await mkdir(directory, { recursive: true });
  const leasePath = path.join(directory, leaseName(marketId));
  try {
    return await createLease(leasePath, ownerId, ttlMs, now);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
  }

  const existing = await readLease(leasePath);
  if (Date.parse(existing?.expiresAt) > now) return null;

  // Rename is the stale-owner fencing operation: only one contender can move
  // this exact lease directory. A stale owner retains a handle to the old path
  // and therefore cannot delete the successor lease created below.
  const abandonedPath = `${leasePath}.abandoned.${process.pid}.${randomUUID()}`;
  try {
    await rename(leasePath, abandonedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  try {
    return await createLease(leasePath, ownerId, ttlMs, now);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return null;
    throw error;
  } finally {
    await rm(abandonedPath, { recursive: true, force: true });
  }
}


