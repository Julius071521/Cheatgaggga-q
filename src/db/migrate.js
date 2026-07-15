'use strict';
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function runMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name VARCHAR(190) PRIMARY KEY,
    ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const [done] = await pool.query('SELECT name FROM _migrations');
  const doneSet = new Set(done.map((r) => r.name));

  const applied = [];
  for (const file of files) {
    if (doneSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const statements = sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    await pool.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
    applied.push(file);
  }
  return applied;
}

module.exports = { runMigrations };

// CLI usage: node src/db/migrate.js
if (require.main === module) {
  runMigrations()
    .then((applied) => {
      console.log(applied.length ? `[migrate] Applied: ${applied.join(', ')}` : '[migrate] Up to date.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] Failed:', err.message);
      process.exit(1);
    });
}
