#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { assertDiskCapacity } from '../src/lib/disk-capacity.mjs';

const argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const operation = value('--operation');
if (!operation) {
  console.error('Usage: disk-capacity-check.mjs --operation <scan|build|backup|migration|promotion> [--burst-file path]');
  process.exitCode = 2;
} else {
  let burstBytes;
  const burstFile = value('--burst-file');
  if (burstFile) burstBytes = (await stat(path.resolve(burstFile))).size * 2 + 256_000_000;
  try {
    const result = await assertDiskCapacity(operation, { burstBytes });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
