import { createClient } from '@libsql/client';

const db = createClient({ url: 'file:data/edgefinder.db' });
try {
  const [integrity, foreignKeys] = await Promise.all([
    db.execute('PRAGMA integrity_check'),
    db.execute('PRAGMA foreign_key_check'),
  ]);
  console.log(JSON.stringify({
    integrity: integrity.rows,
    foreignKeyViolations: foreignKeys.rows.length,
  }, null, 2));
} finally {
  db.close();
}
