#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EVIDENCE_ROOT,
  markDelivered,
  recordIrrecoverableEvidence,
  registerEvidence,
  verifyEvidence,
} from '../src/lib/protected-evidence.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = rest[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  if (!options[key]) throw new Error(`Missing --${key}`);
  return options[key];
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const root = options.root || process.env.H2H_EVIDENCE_ROOT || DEFAULT_EVIDENCE_ROOT;
  let result;
  if (command === 'register') {
    result = registerEvidence({
      root,
      sourcePath: required(options, 'source'),
      taskId: required(options, 'task'),
      evidenceId: required(options, 'id'),
      kind: options.kind || 'recovery',
      ownerProfile: options.owner,
      deliveryState: options.delivery || 'pending',
      expiresAt: options.expires || null,
    });
  } else if (command === 'record-loss') {
    result = recordIrrecoverableEvidence({
      root,
      expectedPath: required(options, 'expected-path'),
      taskId: required(options, 'task'),
      evidenceId: required(options, 'id'),
      kind: options.kind || 'recovery',
      ownerProfile: options.owner,
      reason: required(options, 'reason'),
    });
  } else if (command === 'verify' || command === 'status') {
    result = verifyEvidence({
      root,
      taskId: required(options, 'task'),
      evidenceId: required(options, 'id'),
    });
    if (command === 'status') {
      result = {
        taskId: result.manifest.owner.taskId,
        evidenceId: result.manifest.evidenceId,
        state: result.state,
        preserved: result.preserved,
        checkedAt: result.checkedAt || new Date().toISOString(),
        delivery: result.manifest.delivery,
        hash: result.actual?.sha256 || result.manifest.payload?.sha256 || null,
        manifestPath: result.manifestPath,
        preservationBasis: result.preserved
          ? 'current-byte-count-and-sha256-verification'
          : 'no-current-byte-identical-payload',
      };
    }
  } else if (command === 'mark-delivered') {
    result = markDelivered({
      root,
      taskId: required(options, 'task'),
      evidenceId: required(options, 'id'),
      reference: required(options, 'reference'),
    });
  } else {
    throw new Error('Usage: protected-evidence.mjs register|record-loss|verify|status|mark-delivered [options]');
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
