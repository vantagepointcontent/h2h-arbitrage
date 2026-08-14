import { readFile } from 'node:fs/promises';

async function readMarketArray(file) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`Saved-market data is not an array: ${file}`);
  return value;
}

export async function readSavedMarketsFailSafe(file) {
  const backup = `${file}.bak`;
  let primary;
  let primaryError = null;
  try {
    primary = await readMarketArray(file);
  } catch (error) {
    primaryError = error;
  }

  if (primary && primary.length > 0) return primary;

  try {
    const recovered = await readMarketArray(backup);
    if (primaryError || recovered.length > 0) return recovered;
  } catch (backupError) {
    if (primaryError) {
      throw new AggregateError([primaryError, backupError], `Saved-market primary and backup are unreadable: ${file}`);
    }
  }

  if (primary) return primary;
  throw primaryError;
}
