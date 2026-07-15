'use strict';
const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter = null;
if (env.EMAIL_HOST && env.EMAIL_USER && env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: env.EMAIL_SECURE, // true for 465, false for 587/25 (STARTTLS)
    requireTLS: !env.EMAIL_SECURE,
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 25000,
    tls: {
      servername: env.EMAIL_TLS_SERVERNAME || undefined,
      // Some shared hosts present a hostname-mismatched cert; don't hard-fail delivery.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
  });

  // Verify the SMTP connection on boot (non-blocking) so misconfig is obvious in logs.
  transporter.verify()
    .then(() => console.log(`[mailer] SMTP ready (${env.EMAIL_HOST}:${env.EMAIL_PORT})`))
    .catch((err) => console.warn(`[mailer] SMTP verify failed (${env.EMAIL_HOST}:${env.EMAIL_PORT}): ${err.message}`));
}

function layout(title, bodyHtml) {
  return `
  <div style="background:#f4f6fb;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e9f2;">
      <div style="background:linear-gradient(135deg,#2563eb,#0ea5e9);padding:22px 28px;">
        <span style="color:#ffffff;font-size:20px;font-weight:bold;">${env.SITE_NAME}</span>
      </div>
      <div style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">
        <h2 style="margin:0 0 14px;font-size:18px;color:#111827;">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="padding:18px 28px;background:#f9fafb;color:#6b7280;font-size:12px;border-top:1px solid #eef0f5;">
        ${env.SITE_NAME} · ${env.SITE_DOMAIN}${env.SUPPORT_EMAIL ? ` · Need help? <a href="mailto:${env.SUPPORT_EMAIL}" style="color:#2563eb;">${env.SUPPORT_EMAIL}</a>` : ''}
      </div>
    </div>
  </div>`;
}

function button(url, label) {
  return `<p style="margin:22px 0;"><a href="${url}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:bold;display:inline-block;">${label}</a></p>
  <p style="color:#6b7280;font-size:12px;">If the button doesn't work, copy this link:<br>${url}</p>`;
}

async function send(to, subject, title, bodyHtml) {
  if (!transporter) {
    console.warn(`[mailer] SMTP not configured — skipped email "${subject}" to ${to}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM || env.EMAIL_USER}>`,
      to,
      subject,
      html: layout(title, bodyHtml),
    });
    return true;
  } catch (err) {
    console.error(`[mailer] Failed to send "${subject}" to ${to}: ${err.message}`);
    return false;
  }
}

function sendVerification(to, token) {
  const url = `${env.BASE_URL}/verify/${token}`;
  return send(to, `Verify your ${env.SITE_NAME} account`, 'Confirm your email address',
    `<p>Welcome to ${env.SITE_NAME}! Click the button below to verify your email and activate your account.</p>
     ${button(url, 'Verify my email')}
     <p style="color:#6b7280;font-size:12px;">This link expires in 24 hours. If you didn't sign up, you can ignore this email.</p>`);
}

function sendPasswordReset(to, token) {
  const url = `${env.BASE_URL}/reset/${token}`;
  return send(to, `Reset your ${env.SITE_NAME} password`, 'Password reset request',
    `<p>We received a request to reset your password. Click below to choose a new one.</p>
     ${button(url, 'Reset password')}
     <p style="color:#6b7280;font-size:12px;">This link expires in 1 hour. If you didn't request this, no action is needed.</p>`);
}

function sendDepositResult(to, deposit, approved) {
  const method = String(deposit.payment_method || deposit.method || 'payment').toUpperCase();
  const amount = Number(deposit.amount != null ? deposit.amount : deposit.amount_php).toFixed(2);
  const ref = deposit.reference_id || deposit.reference_no || '';
  const title = approved ? 'Deposit approved 🎉' : 'Deposit rejected';
  const body = approved
    ? `<p>Your ${method} deposit of <b>₱${amount}</b> (ref: ${ref}) has been approved and added to your wallet.</p>
       ${button(`${env.BASE_URL}/dashboard`, 'Go to dashboard')}`
    : `<p>Your ${method} deposit of <b>₱${amount}</b> (ref: ${ref}) was rejected.</p>
       ${deposit.admin_note ? `<p><b>Reason:</b> ${deposit.admin_note}</p>` : ''}
       <p>If you believe this is a mistake, reply to this email with your payment receipt.</p>`;
  return send(to, `${env.SITE_NAME} — deposit ${approved ? 'approved' : 'rejected'}`, title, body);
}

function sendDepositReceived(to, deposit) {
  const method = String(deposit.payment_method || deposit.method || 'payment').toUpperCase();
  const amount = Number(deposit.amount != null ? deposit.amount : deposit.amount_php).toFixed(2);
  const ref = deposit.reference_id || deposit.reference_no || '';
  return send(to, `${env.SITE_NAME} — deposit request received`, 'We received your deposit request ✅',
    `<p>Thanks! We've received your <b>${method}</b> deposit request of <b>₱${amount}</b> (ref: ${ref}).</p>
     <p>Our team is verifying your payment now. Once approved, the amount is added to your wallet automatically and you'll get another email.</p>
     ${button(`${env.BASE_URL}/wallet`, 'View my wallet')}
     <p style="color:#6b7280;font-size:12px;">Most deposits are verified within minutes to a few hours during business time.</p>`);
}

function sendWelcome(to, username) {
  return send(to, `Welcome to ${env.SITE_NAME}! 🚀`, `Welcome aboard, ${username || 'friend'}!`,
    `<p>Your ${env.SITE_NAME} account is ready. Here's how to get started:</p>
     <ol style="padding-left:18px;color:#374151;">
       <li>Add funds via GCash, Maya, or BPI.</li>
       <li>Pick a service and paste your public link.</li>
       <li>Place your order — delivery is automatic. 🎉</li>
     </ol>
     ${button(`${env.BASE_URL}/dashboard`, 'Go to my dashboard')}`);
}

module.exports = { send, sendVerification, sendPasswordReset, sendDepositResult, sendDepositReceived, sendWelcome };
