import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from '../../common/config/environment';
import type { EmailMessage } from './email.provider';

export type EmailBrand = {
  productName: string;
  websiteUrl: string;
  supportEmail: string;
};
export type EmailContent = Pick<EmailMessage, 'subject' | 'html' | 'text' | 'attachments'>;

type EmailTemplateInput = {
  brand: EmailBrand;
  subject: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  greeting: string;
  paragraphs: string[];
  details?: Array<{ label: string; value: string }>;
  action: { label: string; url: string };
  afterAction: string;
  notice: string;
  reason: string;
  qr?: { content: Buffer; eventName: string };
};

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character]!,
  );

export const emailSubject = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').trim();

export const emailBrand = (config: ConfigService<Environment, true>): EmailBrand => ({
  productName: config.get('PRODUCT_NAME', { infer: true }),
  websiteUrl: config.get('EMAIL_WEBSITE_URL', { infer: true }) || 'https://feliam.com',
  supportEmail: config.get('EMAIL_REPLY_TO', { infer: true }) || 'info@feliam.com',
});

// Bundled with the backend so email images never depend on a public frontend or localhost.
let logo: Buffer | undefined;
const logoAttachment = () => ({
  filename: 'feliam-logo.png',
  contentType: 'image/png',
  content: (logo ??= readFileSync(join(__dirname, 'assets/feliam-icon.png'))),
  contentId: 'feliam-logo',
});

export function buildEmail(input: EmailTemplateInput): EmailContent {
  for (const url of [input.action.url, input.brand.websiteUrl]) {
    if (!['http:', 'https:'].includes(new URL(url).protocol))
      throw new Error('InvalidEmailUrl');
  }
  const e = escapeHtml;
  const { brand } = input;
  const subject = emailSubject(input.subject);
  const details = input.details?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:26px 0;background:#F4F6F4;border:1px solid #E1E7E3;border-radius:12px;">${input.details.map(({ label, value }, index) => `<tr><td style="padding:16px 22px;${index ? 'border-top:1px solid #E1E7E3;' : ''}"><div style="color:#61716C;font-size:11px;line-height:18px;letter-spacing:1.2px;text-transform:uppercase;">${e(label)}</div><div style="margin-top:4px;font-size:15px;line-height:23px;color:#16292B;overflow-wrap:anywhere;">${e(value)}</div></td></tr>`).join('')}</table>`
    : '';
  const html = `<!doctype html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(subject)}</title>
<style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}img{border:0;outline:none;text-decoration:none}a{color:#245B50}@media only screen and (max-width:620px){.outer{padding:16px 10px!important}.content{padding:30px 24px!important}.brand{padding:24px!important}.headline{font-size:29px!important;line-height:36px!important}.footer{padding:24px 16px!important}}</style>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;width:100%;background:#F2F1ED;font-family:Arial,Helvetica,sans-serif;color:#16292B;">
<div style="display:none;font-size:1px;line-height:1px;color:#F2F1ED;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${e(input.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F2F1ED;"><tr><td class="outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;table-layout:fixed;">
<tr><td class="brand" style="padding:28px 40px;background:#16292B;border-radius:16px 16px 0 0;">
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td width="56" style="vertical-align:middle;"><a href="${e(brand.websiteUrl)}" style="text-decoration:none;"><img src="cid:feliam-logo" width="44" height="46" alt="${e(brand.productName)} logo" style="display:block;width:44px;height:46px;border-radius:9px;"></a></td><td style="vertical-align:middle;"><a href="${e(brand.websiteUrl)}" style="color:#F5F2EC;text-decoration:none;font-size:26px;font-weight:600;letter-spacing:.4px;">${e(brand.productName)}</a><div style="margin-top:5px;color:#C7D2CE;font-size:12px;line-height:18px;">Your event. Every detail.</div></td></tr></table>
</td></tr>
<tr><td class="content" style="padding:38px 40px 36px;background:#FFFFFF;border:1px solid #E1E4DF;border-top:0;border-radius:0 0 16px 16px;overflow-wrap:anywhere;">
<p style="margin:0 0 14px;color:#527C6D;font-size:11px;line-height:18px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">${e(input.eyebrow)}</p>
<h1 class="headline" style="margin:0 0 26px;color:#16292B;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:41px;font-weight:400;overflow-wrap:anywhere;">${e(input.heading)}</h1>
<p style="margin:0 0 14px;color:#16292B;font-size:16px;line-height:26px;">${e(input.greeting)}</p>
${input.paragraphs.map((paragraph) => `<p style="margin:0 0 16px;color:#4C5C57;font-size:15px;line-height:25px;white-space:pre-line;overflow-wrap:anywhere;">${e(paragraph)}</p>`).join('\n')}
${details}
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 20px;"><tr><td bgcolor="#245B50" style="border-radius:8px;text-align:center;mso-padding-alt:16px 28px;"><a href="${e(input.action.url)}" style="display:inline-block;border:1px solid #245B50;border-radius:8px;padding:16px 28px;color:#FFFFFF;font-size:15px;line-height:20px;font-weight:700;text-decoration:none;mso-padding-alt:0;">${e(input.action.label)}</a></td></tr></table>
<p style="margin:0 0 24px;color:#4C5C57;font-size:14px;line-height:23px;">${e(input.afterAction)}</p>
${input.qr ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;border:1px solid #E1E7E3;border-radius:12px;"><tr><td align="center" style="padding:20px;"><img src="cid:feliam-guest-qr" width="144" height="144" alt="QR code for ${e(input.qr.eventName)}" style="display:block;width:144px;height:144px;"><p style="margin:12px 0 0;color:#61716C;font-size:12px;line-height:19px;">Opening on another device? Scan your personal QR code.</p></td></tr></table>` : ''}
<p style="margin:0;padding:18px 20px;background:#F4F6F4;border-left:3px solid #9CB9A9;border-radius:0 6px 6px 0;color:#52645C;font-size:13px;line-height:21px;">${e(input.notice)}</p>
<div style="margin-top:28px;padding-top:22px;border-top:1px solid #E5E8E3;"><p style="margin:0 0 8px;color:#718078;font-size:12px;line-height:20px;">If the button does not work, copy and paste this link into your browser:</p><a href="${e(input.action.url)}" style="color:#245B50;font-size:12px;line-height:20px;word-break:break-all;overflow-wrap:anywhere;text-decoration:underline;">${e(input.action.url)}</a></div>
</td></tr>
<tr><td class="footer" align="center" style="padding:26px 32px 0;color:#6B7770;font-size:12px;line-height:20px;">
<p style="margin:0 0 6px;color:#344E43;font-size:14px;font-weight:700;">${e(brand.productName)}</p>
<p style="margin:0 0 12px;">Guest concierge for travel, events and hospitality.</p>
<p style="margin:0 0 12px;">Need help? <a href="mailto:${e(brand.supportEmail)}" style="color:#245B50;text-decoration:underline;">${e(brand.supportEmail)}</a><br><a href="${e(brand.websiteUrl)}" style="color:#245B50;text-decoration:underline;">Visit ${e(brand.productName)}</a></p>
<p style="margin:0;">${e(input.reason)}</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;

  const text = [
    brand.productName,
    input.heading,
    input.greeting,
    ...input.paragraphs,
    ...(input.details ?? []).map(({ label, value }) => `${label}: ${value}`),
    `${input.action.label}: ${input.action.url}`,
    input.afterAction,
    input.notice,
    `${brand.productName} | Guest concierge for travel, events and hospitality.`,
    `Need help? ${brand.supportEmail}`,
    brand.websiteUrl,
    input.reason,
  ].join('\n\n');

  return {
    subject,
    html,
    text,
    attachments: [
      logoAttachment(),
      ...(input.qr
        ? [
            {
              filename: 'event-invitation-qr.png',
              contentType: 'image/png',
              content: input.qr.content,
              contentId: 'feliam-guest-qr',
            },
          ]
        : []),
    ],
  };
}
