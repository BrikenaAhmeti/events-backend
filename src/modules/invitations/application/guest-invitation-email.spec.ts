import { buildGuestInvitationEmail } from './guest-invitation-email';
import { QrCodeService } from './qr-code.service';

describe('buildGuestInvitationEmail', () => {
  it('contains client branding, a QR image, and a clickable fallback link', () => {
    const html = buildGuestInvitationEmail({
      productName: 'Feliam',
      companyName: 'Northstar Events',
      guestName: 'Avery Stone',
      eventName: 'Leadership Forum',
      eventDescription: 'A three-day leadership forum.',
      venue: 'Riverside Hall',
      destination: 'Lisbon',
      startAt: new Date('2027-10-12T08:00:00Z'),
      endAt: new Date('2027-10-14T18:00:00Z'),
      timezone: 'Europe/Lisbon',
      invitationUrl: 'https://events.example.test/i/opaque-token',
      logoUrl: 'https://events.example.test/brand/feliam-icon.png',
    });

    expect(html).toContain('Northstar Events');
    expect(html).toContain('cid:feliam-guest-qr');
    expect(html).toContain('https://events.example.test/i/opaque-token');
    expect(html).toContain('Open event invitation');
    expect(html).toContain('Please do not forward it.');
  });
});

describe('QrCodeService', () => {
  it('creates a high-resolution PNG for the safe invitation URL', async () => {
    const png = await new QrCodeService().toPng('https://events.example.test/i/opaque-token');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.byteLength).toBeGreaterThan(1_000);
  });
});
