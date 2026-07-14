'use strict';
// Usage: node src/db/seed.js admin@example.com "StrongPassword123"
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function seed() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node src/db/seed.js <admin-email> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role, email_verified_at)
     VALUES (?, ?, 'Administrator', 'admin', NOW())
     ON DUPLICATE KEY UPDATE role = 'admin', password_hash = VALUES(password_hash), email_verified_at = NOW()`,
    [email.toLowerCase().trim(), hash]
  );
  console.log(`[seed] Admin account ready: ${email}`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] Failed:', err.message);
    process.exit(1);
  });
