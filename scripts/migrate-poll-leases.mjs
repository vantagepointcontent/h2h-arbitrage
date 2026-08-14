import { randomUUID } from 'node:crypto';
import { readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function quarantineLegacyPollLeases(leaseDirectory, { confirmedStopped = false } = {}) {
  if (!confirmedStopped) {
    throw new Error('Refusing lease migration until the legacy poller is confirmed stopped');
  }

  let entries;
  try {
    entries = await readdir(leaseDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const quarantined = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes('.legacy-quarantine.')) continue;
    const leasePath = path.join(leaseDirectory, entry.name);
    try {
      await stat(path.join(leasePath, 'kernel.lock'));
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const quarantinePath = `${leasePath}.legacy-quarantine.${Date.now()}.${randomUUID()}`;
    await rename(leasePath, quarantinePath);
    quarantined.push({ leasePath, quarantinePath });
  }
  return quarantined;
}

export function pollLeaseDirectory(env = process.env, cwd = process.cwd()) {
  return env.H2H_SAVED_MARKET_LEASE_DIRECTORY
    || path.join(cwd, 'data', 'saved-market-leases');
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const leaseDirectory = pollLeaseDirectory();
  const quarantined = await quarantineLegacyPollLeases(leaseDirectory, {
    confirmedStopped: process.env.H2H_POLLER_CONFIRMED_STOPPED === '1',
  });
  console.log(JSON.stringify({ leaseDirectory, quarantinedCount: quarantined.length }));
}
