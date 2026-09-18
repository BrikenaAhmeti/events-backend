import { buildPasswordResetEmail, buildStaffInvitationEmail } from './account-emails';

const brand = {
  productName: 'Feliam',
  websiteUrl: 'https://feliam.com',
  supportEmail: 'info@feliam.com',
};

describe('account emails', () => {
  it('escapes untrusted invitation content and preserves the exact action in both formats', () => {
    const invitationUrl = 'https://app.feliam.com/activate?token_hash=a%2Bb&source=email';
    const email = buildStaffInvitationEmail({
      brand,
      firstName: '<img src=x onerror=alert(1)>',
      companyName: 'North & South\r\nEvents',
      invitationUrl,
    });
    expect(email.subject).toBe('North & South Events invited you to Feliam');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('North &amp; South');
    expect(email.html).toContain(
      'href="https://app.feliam.com/activate?token_hash=a%2Bb&amp;source=email"',
    );
    expect(email.text).toContain(invitationUrl);
    expect(email.text).toContain('activate your account');
    expect(email.html).toContain('mailto:info@feliam.com');
    expect(email.attachments?.[0].content.subarray(1, 4).toString()).toBe('PNG');
    expect(email.attachments?.[0].contentId).toBe('feliam-logo');
  });

  it('includes recovery instructions and a safe no-action option without inventing an expiry', () => {
    const resetUrl = 'https://app.feliam.com/reset-password?token_hash=token';
    const email = buildPasswordResetEmail({ brand, resetUrl });
    expect(email.subject).toBe('Reset your Feliam password');
    expect(email.text).toContain(resetUrl);
    expect(email.text).toContain('Your password will stay the same');
    expect(email.text).toContain('request a new link');
    expect(email.text).not.toMatch(/\d+ (minutes|hours)/);
    expect(email.html).toContain('cid:feliam-logo');
    expect(email.html).not.toContain('localhost');
    expect(Buffer.byteLength(email.html)).toBeLessThan(100_000);
  });

  it('rejects unsafe action URLs', () => {
    expect(() => buildPasswordResetEmail({ brand, resetUrl: 'javascript:alert(1)' })).toThrow(
      'InvalidEmailUrl',
    );
  });
});
