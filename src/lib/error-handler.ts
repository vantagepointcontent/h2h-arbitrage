import logger, { errorFingerprint, fingerprintHash } from './logger';
import { correlationId } from './correlation';
import { spikeDetector } from './spike-alert';

// ---------------------------------------------------------------------------
// SEC-002: client-safe error messages
// Logs the FULL error server-side (message, stack, fingerprint) but returns
// only a generic, user-facing string to the client, so internal details
// (upstream API errors, file paths, SQL errors) never leak in responses.
// The correlationId in logs lets you match a client report to the full error.
// ---------------------------------------------------------------------------

export function clientSafeError(error: unknown, fallback = 'Internal server error', ctx?: { path?: string }): string {
  const fp = errorFingerprint(error);
  const fpHash = fingerprintHash(fp);
  const msg = error instanceof Error ? error.message : String(error);
  const cid = correlationId.current;
  spikeDetector.record({ fingerprint: fp, message: msg });
  logger.error(msg, {
    error,
    fingerprint: fp,
    fingerprintHash: fpHash,
    path: ctx?.path,
    correlationId: cid,
  });
  // Client gets: generic message + error CLASS (safe) + fingerprint hash +
  // correlation id. Enough verbosity to report/debug ("grep the log for
  // ref:xxxx"), without leaking upstream error details, paths, or SQL.
  const kind = error instanceof Error ? error.constructor.name : 'Error';
  const ref = cid ? `${fpHash}/${cid}` : fpHash;
  return `${fallback} (${kind}, ref: ${ref})`;
}
