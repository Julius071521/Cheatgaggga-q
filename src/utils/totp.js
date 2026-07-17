'use strict';
// RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) using only Node's crypto —
// no external dependency, so nothing to npm-install on the host. Compatible
// with Google Authenticator / Authy / Microsoft Authenticator.
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// A fresh 20-byte secret as a base32 string.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// The 6-digit code for a given secret + counter (defaults to the current 30s step).
function codeForCounter(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

// Verify a user-entered token, allowing ±`window` 30s steps for clock skew.
function verify(secretBase32, token, window = 1) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== 6 || !secretBase32) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    // Constant-time-ish compare (short fixed-length strings).
    if (safeEq(codeForCounter(secretBase32, counter + w), clean)) return true;
  }
  return false;
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

// otpauth:// URI for QR codes / manual setup-key entry.
function otpauthUrl(secretBase32, label, issuer) {
  const l = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${l}?${params.toString()}`;
}

module.exports = { generateSecret, verify, codeForCounter, otpauthUrl, base32Encode, base32Decode };
