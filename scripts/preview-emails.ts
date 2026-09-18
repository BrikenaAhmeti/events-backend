import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import {
  buildPasswordResetEmail,
  buildStaffInvitationEmail,
} from '../src/infrastructure/email/account-emails';
import { buildGuestInvitationEmail } from '../src/modules/invitations/application/guest-invitation-email';
import { escapeHtml } from '../src/infrastructure/email/email-template';

async function main() {
  const output = resolve(process.argv[2] || join(tmpdir(), 'feliam-email-previews'));
  await mkdir(output, { recursive: true });
  const brand = {
    productName: 'Feliam',
    websiteUrl: 'https://feliam.com',
    supportEmail: 'info@feliam.com',
  };
  // Demonstration links only: never generate real authentication tokens or send mail.
  const invitationUrl = 'https://app.feliam.com/i/preview-only';
  const emails = {
    'staff-invitation': buildStaffInvitationEmail({
      brand,
      firstName: 'Avery',
      companyName: 'Northstar Events',
      invitationUrl: 'https://app.feliam.com/activate?token_hash=preview-only',
    }),
    'guest-invitation': buildGuestInvitationEmail({
      brand,
      companyName: 'Northstar Events',
      guestName: 'Avery',
      eventName: 'The Leadership Gathering',
      eventDescription:
        'Join us in Lisbon for thoughtful conversations, new connections and a shared look at what comes next.',
      venue: 'Riverside Hall',
      destination: 'Lisbon, Portugal',
      startAt: new Date('2027-10-12T08:00:00Z'),
      endAt: new Date('2027-10-12T17:00:00Z'),
      timezone: 'Europe/Lisbon',
      invitationUrl,
      qrPng: await QRCode.toBuffer(invitationUrl, { width: 440, margin: 2 }),
    }),
    'password-reset': buildPasswordResetEmail({
      brand,
      resetUrl: 'https://app.feliam.com/reset-password?token_hash=preview-only',
    }),
  };
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  for (const [name, email] of Object.entries(emails)) {
    let html = email.html;
    for (const attachment of email.attachments ?? []) {
      html = html.replaceAll(
        `cid:${attachment.contentId}`,
        `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`,
      );
    }
    await writeFile(join(output, `${name}.html`), html);
    await writeFile(join(output, `${name}.txt`), email.text);
    const mime = await transport.sendMail({
      from: 'Feliam <info@feliam.com>',
      replyTo: 'info@feliam.com',
      to: 'avery@example.test',
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments?.map(({ contentId, ...attachment }) => ({
        ...attachment,
        cid: contentId,
        contentDisposition: 'inline',
      })),
    });
    await writeFile(join(output, `${name}.eml`), mime.message);
  }
  await writeFile(
    join(output, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feliam email previews</title><style>*{box-sizing:border-box}body{margin:0;background:#F2F1ED;color:#16292B;font-family:Arial,sans-serif}header{padding:30px 36px;background:#16292B;color:#F5F2EC}h1{font-family:Georgia,serif;font-weight:400;margin:0 0 12px}header p{margin:0;color:#C7D2CE;font-size:14px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;padding:24px}article{min-width:0}h2{font-size:14px;margin:0 0 10px}p{font-size:12px;line-height:20px}a{color:#245B50}iframe{width:100%;height:1540px;border:1px solid #DCE1DC;border-radius:12px;background:#F2F1ED}</style></head><body><header><h1>Feliam, in every inbox.</h1><p>Staff invitations · Guest invitations · Account security</p></header><main>${Object.entries(
      emails,
    )
      .map(
        ([name, email]) =>
          `<article><h2>${escapeHtml(email.subject)}</h2><p><a href="${name}.html">Full preview</a> · <a href="${name}.txt">Plain text</a> · <a href="${name}.eml">Email file</a></p><iframe title="${escapeHtml(email.subject)}" src="${name}.html"></iframe></article>`,
      )
      .join('')}</main></body></html>`,
  );
  console.log(`Email previews created at ${output}/index.html (no email sent).`);
}
void main();
