'use strict';
// Internal endpoints for the owner's VPS guard (not linked anywhere public).
// GET /internal/backup — streams a gzipped SQL dump of the whole database.
// Auth: X-Backup-Token header must equal env.BACKUP_TOKEN (endpoint is
// disabled entirely when the env var is not set). Used by the nightly VPS
// backup script so there is always an off-server copy of the business data.
const express = require('express');
const zlib = require('zlib');
const crypto = require('crypto');
const pool = require('../db/pool');
const env = require('../config/env');

const router = express.Router();

function tokenOk(req) {
  const want = String(env.BACKUP_TOKEN || '');
  const got = String(req.get('x-backup-token') || '');
  if (!want || want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  if (Buffer.isBuffer(val)) return `0x${val.toString('hex')}`;
  if (val instanceof Date) return pool.escape(val);
  return pool.escape(String(val));
}

router.get('/internal/backup', async (req, res) => {
  if (!tokenOk(req)) return res.status(404).end(); // look like nothing is here
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="apexboost-${new Date().toISOString().slice(0, 10)}.sql.gz"`);
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(res);
  const w = (s) => gz.write(s);
  try {
    w(`-- ApexBoost backup ${new Date().toISOString()}\nSET FOREIGN_KEY_CHECKS=0;\nSET NAMES utf8mb4;\n\n`);
    const [tables] = await pool.query('SHOW TABLES');
    const names = tables.map((r) => Object.values(r)[0]);
    for (const t of names) {
      const [[create]] = await pool.query(`SHOW CREATE TABLE \`${t}\``);
      w(`DROP TABLE IF EXISTS \`${t}\`;\n${create['Create Table']};\n\n`);
      // Page through rows so big tables never load fully into memory.
      const CHUNK = 500;
      for (let offset = 0; ; offset += CHUNK) {
        const [rows] = await pool.query(`SELECT * FROM \`${t}\` LIMIT ? OFFSET ?`, [CHUNK, offset]);
        if (!rows.length) break;
        const cols = Object.keys(rows[0]).map((c) => `\`${c}\``).join(',');
        const values = rows.map((r) => `(${Object.values(r).map(esc).join(',')})`).join(',\n');
        w(`INSERT INTO \`${t}\` (${cols}) VALUES\n${values};\n`);
        if (rows.length < CHUNK) break;
      }
      w('\n');
    }
    w('SET FOREIGN_KEY_CHECKS=1;\n');
    gz.end();
  } catch (err) {
    console.error('[internal] backup failed:', err.message);
    try { gz.destroy(); res.destroy(); } catch (_) { /* already gone */ }
  }
});

module.exports = router;
