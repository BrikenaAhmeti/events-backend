import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { Environment } from '../../../common/config/environment';
import type { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { TokenService } from '../../../common/security/token.service';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { EmailMessage } from '../../../infrastructure/email/email.provider';
import type { JobQueue } from '../../../infrastructure/jobs/job-queue';
import type { EventGateway } from '../../../infrastructure/websocket/event.gateway';
import type { SupabaseAuthProvider } from '../../auth/infrastructure/supabase-auth.provider';
import { CommunicationWorker } from './communication.worker';
import { QrCodeService } from './qr-code.service';

describe('CommunicationWorker guest invitations', () => {
  it.each(['PUBLISHED', 'CANCELLED'] as const)('handles a queued invitation for a %s event', async (status) => {
    const invitation = {
      id: 'invitation-a', eventId: 'event-a', status: 'QUEUED', sentAt: null,
      tokenEncrypted: null, tokenHash: null, expiresAt: new Date(Date.now() + 86_400_000),
      guest: { fullName: 'Avery Stone', email: 'avery@example.test', notesEncrypted: null },
      event: {
        status, name: 'Leadership Forum', description: 'A leadership gathering.',
        client: { name: 'Northstar Events' }, venue: 'Riverside Hall', destination: 'Lisbon',
        startAt: new Date(Date.now() + 3_600_000), endAt: new Date(Date.now() + 7_200_000), timezone: 'Europe/Lisbon',
      },
    };
    const update = vi.fn<(input: { data: Record<string, unknown> }) => Promise<void>>().mockResolvedValue();
    const send = vi.fn<(message: EmailMessage) => Promise<{ id: string }>>().mockResolvedValue({ id: 'mail-a' });
    const complete = vi.fn();
    const fail = vi.fn();
    const qr = new QrCodeService();
    const qrPng = vi.spyOn(qr, 'toPng');
    const config = { get: (key: string) => ({
      PUBLIC_APP_URL: 'https://events.example.test', PRODUCT_NAME: 'Feliam',
      EMAIL_WEBSITE_URL: 'https://feliam.com', EMAIL_REPLY_TO: 'info@feliam.com',
    })[key] } as unknown as ConfigService<Environment, true>;
    const worker = new CommunicationWorker(
      { invitation: { findUnique: vi.fn().mockResolvedValue(invitation), update } } as unknown as PrismaService,
      { claim: vi.fn().mockResolvedValue({ id: 'job-a', type: 'INVITATION_SEND', payload: { invitationId: invitation.id } }), complete, fail } as unknown as JobQueue,
      new TokenService(), { encrypt: (value: string) => `encrypted:${value}`, decrypt: () => null } as unknown as FieldEncryptionService,
      { send }, {} as SupabaseAuthProvider, config,
      { emitEvent: vi.fn() } as unknown as EventGateway, { warn: vi.fn() } as unknown as PinoLogger, qr,
    );
    await worker.tick();
    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith('job-a');
    if (status === 'CANCELLED') {
      expect(send).not.toHaveBeenCalled();
      expect(update.mock.calls[0]?.[0].data.status).toBe('REVOKED');
      return;
    }
    const url = qrPng.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/events.example.test\/i\/[A-Za-z0-9_-]{43}$/);
    expect(update.mock.calls[0]?.[0].data.tokenHash).toBe(new TokenService().hash(url.split('/').at(-1)!));
    const message = send.mock.calls[0]?.[0];
    expect(message?.to).toBe('avery@example.test');
    expect(message?.idempotencyKey).toBe('invitation-invitation-a');
    expect(message?.html).toContain(`href="${url}"`);
    expect(message?.text).toContain(url);
    expect(Buffer.isBuffer(message?.attachments?.find(({ contentId }) => contentId === 'feliam-guest-qr')?.content)).toBe(true);
    expect(update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: 'SENT', tokenEncrypted: null });
  });
});
