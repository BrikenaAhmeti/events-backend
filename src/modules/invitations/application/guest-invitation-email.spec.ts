import { buildGuestInvitationEmail } from './guest-invitation-email';
import { QrCodeService } from './qr-code.service';

describe('buildGuestInvitationEmail', () => {
  it('contains client branding, a QR image, and a clickable fallback link', () => {
    const { html, text, attachments, subject } = buildGuestInvitationEmail({
      brand: {
        productName: 'Feliam',
        websiteUrl: 'https://feliam.com',
        supportEmail: 'info@feliam.com',
      },
      companyName: 'Northstar Events',
      guestName: 'Avery Stone',
      eventName: 'Leadership Forum',
      eventDescription: 'A three-day leadership forum.',
      venue: 'Riverside Hall',
      destination: 'Lisbon',
      startAt: new Date('2027-10-12T08:00:00Z'),
      endAt: new Date('2027-10-14T18:00:00Z'),
      timezone: 'Europe/Lisbon',
      personalDetails: 'Seat B12. Enter through the west door.',
      invitationUrl: 'https://events.example.test/i/opaque-token',
      qrPng: Buffer.from('qr-image'),
    });

    expect(html).toContain('Northstar Events');
    expect(html).toContain('cid:feliam-guest-qr');
    expect(html).toContain('https://events.example.test/i/opaque-token');
    expect(html).toContain('Open event invitation');
    expect(html).toContain('Please do not forward it.');
    expect(html).toContain('cid:feliam-logo');
    expect(text).toContain('Riverside Hall, Lisbon');
    expect(text).toContain('Seat B12. Enter through the west door.');
    expect(text).toContain('09:00 (Europe/Lisbon)');
    expect(text).toContain('https://events.example.test/i/opaque-token');
    expect(text).toContain('Open your personal link or scan the QR code');
    expect(text).not.toContain('Confirm your name and email');
    expect(text).toContain('right away, until four hours after the event ends');
    expect(subject).toBe('Northstar Events: your invitation to Leadership Forum');
    expect(attachments?.map((attachment) => attachment.contentId)).toEqual([
      'feliam-logo',
      'feliam-guest-qr',
    ]);
  });

  it('handles incomplete event details and falls back to UTC for legacy invalid timezones', () => {
    const input = {
      brand: {
        productName: 'Feliam',
        websiteUrl: 'https://feliam.com',
        supportEmail: 'info@feliam.com',
      },
      companyName: 'Northstar',
      guestName: '',
      eventName: 'Forum',
      eventDescription: null,
      venue: null,
      destination: null,
      startAt: null,
      endAt: null,
      timezone: 'invalid/timezone',
      invitationUrl: 'https://events.example.test/i/token',
      qrPng: Buffer.from('qr'),
    };
    const missing = buildGuestInvitationEmail(input);
    expect(missing.text).toContain('Hello,');
    expect(missing.text).toContain('Starts: To be confirmed');
    expect(missing.text).toContain('Location: To be confirmed');
    expect(missing.text).not.toContain('Ends:');
    expect(
      buildGuestInvitationEmail({
        ...input,
        startAt: new Date('2027-10-12T08:00:00Z'),
      }).text,
    ).toContain('08:00 (UTC)');
  });
});

describe('QrCodeService', () => {
  it('creates a high-resolution PNG for the safe invitation URL', async () => {
    const png = await new QrCodeService().toPng('https://events.example.test/i/opaque-token');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.byteLength).toBeGreaterThan(1_000);
  });
});
