'use strict';
// Password hashing/verification that is backward-compatible with the existing
// production database. Stored passwords may be:
//   • bcrypt        ($2a$ / $2b$ ...)
//   • pbkdf2        (pbkdf2$<salt>$<derivedHex>)
//   • legacy plain  (anything else) — never accepted for login; the user must
//     use OTP / Google / password reset, exactly like the old app behaved.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const PBKDF2_ITER = 120000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

function isPasswordHash(value) {
  return typeof value === 'string' &&
    (value.startsWith('pbkdf2$') || value.startsWith('$2a$') || value.startsWith('$2b$'));
}

async function hashSecret(secret) {
  return bcrypt.hash(String(secret), 12);
}

async function verifySecret(secret, storedHash) {
  if (!secret || !storedHash || typeof storedHash !== 'string') return false;

  if (storedHash.startsWith('pbkdf2$')) {
    const [, salt, derived] = storedHash.split('$');
    if (!salt || !derived) return false;
    try {
      const computed = crypto.pbkdf2Sync(String(secret), salt, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
      const a = Buffer.from(computed, 'hex');
      const b = Buffer.from(derived, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) {
      return false;
    }
  }

  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
    try {
      return await bcrypt.compare(String(secret), storedHash);
    } catch (_) {
      return false;
    }
  }

  return false;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { isPasswordHash, hashSecret, verifySecret, sha256 };
