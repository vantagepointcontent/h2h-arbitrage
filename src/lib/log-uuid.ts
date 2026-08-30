import { randomBytes } from 'node:crypto';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALPHANUMERIC = `${LETTERS}${DIGITS}`;

export const LOG_UUID_PATTERN = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6}$/;
export const LOG_UUID_BACKFILL_CAPACITY = LETTERS.length * DIGITS.length * (ALPHANUMERIC.length ** 4);

/** Six-character, uppercase audit reference with an explicit letter and digit. */
export function generateLogUuid(): string {
  const bytes = randomBytes(6);
  return [
    LETTERS[bytes[0] % LETTERS.length],
    DIGITS[bytes[1] % DIGITS.length],
    ...Array.from(bytes.subarray(2), (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]),
  ].join('');
}

export function isLogUuidCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed: scan_results.log_uuid')
    || message.includes('idx_scan_results_log_uuid');
}

/** Retry only the expected UUID uniqueness race; every other write error fails closed. */
export async function insertWithUniqueLogUuid<T>(
  insert: (logUuid: string) => Promise<T>,
  generate: () => string = generateLogUuid,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logUuid = generate();
    if (!LOG_UUID_PATTERN.test(logUuid)) {
      throw new Error(`Generated invalid Logs UUID: ${logUuid}`);
    }
    try {
      return await insert(logUuid);
    } catch (error) {
      if (!isLogUuidCollision(error)) throw error;
    }
  }
  throw new Error('Unable to allocate a unique Logs UUID after 100 attempts');
}
