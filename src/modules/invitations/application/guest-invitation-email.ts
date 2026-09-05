type GuestInvitationEmailInput = {
  productName: string;
  companyName: string;
  guestName: string;
  eventName: string;
  eventDescription: string | null;
  venue: string | null;
  destination: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timezone: string | null;
  invitationUrl: string;
  logoUrl: string;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ??
      character,
  );

const formatDate = (value: Date | null, timezone: string | null): string => {
  if (!value) return 'To be confirmed';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone ?? 'UTC',
  }).format(value);
};

export const buildGuestInvitationEmail = (input: GuestInvitationEmailInput): string => {
  const location = input.venue ?? input.destination ?? 'Location to be confirmed';
  const description = input.eventDescription
    ? `<p style="margin:0 0 24px;color:#465457;font-size:16px;line-height:26px;">${escapeHtml(input.eventDescription)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.eventName)}</title></head>
<body style="margin:0;background:#E8E8E6;font-family:Arial,sans-serif;color:#16292B;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your secure invitation and event concierge access.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#E8E8E6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#F5F2EC;border:1px solid #D5D8D6;border-radius:20px;overflow:hidden;">
<tr><td style="background:#16292B;padding:28px 36px;text-align:center;">
<img src="${escapeHtml(input.logoUrl)}" width="62" height="65" alt="${escapeHtml(input.productName)}" style="display:block;margin:0 auto 12px;width:62px;height:auto;">
<div style="color:#F5F2EC;font-size:24px;letter-spacing:.5px;">${escapeHtml(input.productName)}</div>
<div style="margin-top:8px;color:#C9CFCE;font-size:13px;letter-spacing:1.4px;text-transform:uppercase;">${escapeHtml(input.companyName)}</div>
</td></tr>
<tr><td style="padding:40px 36px 18px;">
<div style="color:#8A9598;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Personal invitation</div>
<h1 style="margin:12px 0 16px;font-size:34px;line-height:41px;font-weight:500;color:#16292B;">${escapeHtml(input.eventName)}</h1>
<p style="margin:0 0 12px;color:#16292B;font-size:17px;line-height:27px;">Hello ${escapeHtml(input.guestName)},</p>
${description}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;border-collapse:separate;border-spacing:0;background:#FFFFFF;border:1px solid #D5D8D6;border-radius:14px;">
<tr><td style="padding:17px 20px;border-bottom:1px solid #E3E5E3;color:#8A9598;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Starts</td><td style="padding:17px 20px;border-bottom:1px solid #E3E5E3;text-align:right;font-size:14px;font-weight:600;">${escapeHtml(formatDate(input.startAt, input.timezone))}</td></tr>
<tr><td style="padding:17px 20px;border-bottom:1px solid #E3E5E3;color:#8A9598;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Ends</td><td style="padding:17px 20px;border-bottom:1px solid #E3E5E3;text-align:right;font-size:14px;font-weight:600;">${escapeHtml(formatDate(input.endAt, input.timezone))}</td></tr>
<tr><td style="padding:17px 20px;color:#8A9598;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Location</td><td style="padding:17px 20px;text-align:right;font-size:14px;font-weight:600;">${escapeHtml(location)}</td></tr>
</table>
<p style="margin:0 0 22px;color:#465457;font-size:15px;line-height:24px;">Scan the QR code or use the button below. You will confirm your name and email once before entering.</p>
<div style="text-align:center;margin:0 0 24px;"><img src="cid:feliam-guest-qr" width="220" height="220" alt="QR code for ${escapeHtml(input.eventName)}" style="display:inline-block;width:220px;height:220px;border:12px solid #FFFFFF;border-radius:12px;"></div>
<div style="text-align:center;"><a href="${escapeHtml(input.invitationUrl)}" style="display:inline-block;background:#16292B;color:#F5F2EC;text-decoration:none;font-size:15px;font-weight:700;padding:15px 26px;border-radius:10px;">Open event invitation</a></div>
<p style="margin:24px 0 0;color:#8A9598;font-size:12px;line-height:19px;word-break:break-all;">If the button does not work, copy this secure link:<br><a href="${escapeHtml(input.invitationUrl)}" style="color:#16292B;">${escapeHtml(input.invitationUrl)}</a></p>
</td></tr>
<tr><td style="padding:24px 36px 34px;">
<div style="border-top:1px solid #D5D8D6;padding-top:22px;color:#8A9598;font-size:12px;line-height:19px;text-align:center;">Sent for ${escapeHtml(input.companyName)} through ${escapeHtml(input.productName)}.<br>This secure link is personal. Please do not forward it.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
};
