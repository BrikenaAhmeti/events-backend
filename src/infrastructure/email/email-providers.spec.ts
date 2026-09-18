import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { validateEnvironment, type Environment } from '../../common/config/environment';
import { buildPasswordResetEmail } from './account-emails';
import { ResendEmailProvider } from './resend-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

const mocks = vi.hoisted(() => ({ resend: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.resend };
  },
}));

const config = new ConfigService<Environment, true>(
  validateEnvironment({
    NODE_ENV: 'test',
    EMAIL_FROM: 'Feliam <info@feliam.com>',
    EMAIL_REPLY_TO: 'info@feliam.com',
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'info@feliam.com',
    SMTP_PASSWORD: 'test',
    RESEND_API_KEY: 'test',
  }),
);
const message = {
  to: 'guest@example.test',
  idempotencyKey: 'recovery-123',
  ...buildPasswordResetEmail({
    brand: {
      productName: 'Feliam',
      websiteUrl: 'https://feliam.com',
      supportEmail: 'info@feliam.com',
    },
    resetUrl: 'https://app.feliam.com/reset-password?token_hash=example',
  }),
};

describe('email delivery contracts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds multipart SMTP mail with text, HTML, an inline logo and a stable sender-domain message ID', async () => {
    // Use Nodemailer’s real MIME builder without connecting or delivering any email.
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const sendMail = vi.spyOn(transport, 'sendMail');
    const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue(transport);
    await new SmtpEmailProvider(config).send(message);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ requireTLS: true, secure: false }),
    );
    const result = (await sendMail.mock.results[0].value) as { message: Buffer };
    const mime = result.message.toString().replace(/\r?\n[ \t]+/g, ' ');
    expect(mime).toContain('From: Feliam <info@feliam.com>');
    expect(mime).toContain('Reply-To: info@feliam.com');
    expect(mime).toContain(
      `Message-ID: <${createHash('sha256').update(message.idempotencyKey).digest('hex')}@feliam.com>`,
    );
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain');
    expect(mime).toContain('Content-Type: text/html');
    expect(mime).toContain('Content-ID: <feliam-logo>');
    expect(mime).toContain('Content-Disposition: inline; filename=feliam-logo.png');
    expect(mime).not.toContain('feliam.local');
  });

  it('preserves text, reply address, inline content IDs and idempotency through Resend', async () => {
    mocks.resend.mockResolvedValueOnce({ data: { id: 'sent-1' }, error: null });
    await expect(new ResendEmailProvider(config).send(message)).resolves.toEqual({
      id: 'sent-1',
    });
    expect(mocks.resend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Feliam <info@feliam.com>',
        replyTo: 'info@feliam.com',
        html: message.html,
        text: message.text,
        attachments: [
          expect.objectContaining({
            contentId: 'feliam-logo',
            content: expect.any(Buffer) as Buffer,
          }),
        ],
      }),
      { idempotencyKey: 'recovery-123' },
    );
  });
});
