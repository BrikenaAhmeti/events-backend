import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../../common/config/environment';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { OutboxService } from '../../../infrastructure/jobs/outbox.service';
import { GuestAccessWindowService } from '../../guest-access/application/guest-access-window.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { InvitationsService } from './invitations.service';
import type { QrCodeService } from './qr-code.service';

describe('InvitationsService', () => {
  it('queues one secure invitation job for every unsent guest', async () => {
    const event = {
      id: 'event-a',
      clientId: 'client-a',
      slug: 'leadership-forum',
      status: 'PUBLISHED',
      endAt: new Date('2027-10-14T18:00:00Z'),
    };
    const transaction = {
      $executeRaw: vi.fn(),
      guest: {
        findMany: vi.fn().mockResolvedValue([{ id: 'guest-a' }, { id: 'guest-b' }]),
        count: vi.fn().mockResolvedValue(2),
      },
      invitation: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: 'invitation-a' })
          .mockResolvedValueOnce({ id: 'invitation-b' }),
      },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService;
    const outbox = { create: vi.fn() };
    const service = new InvitationsService(
      prisma,
      new AuthorizationService(),
      outbox as unknown as OutboxService,
      {} as QrCodeService,
      { get: vi.fn() } as unknown as ConfigService<Environment, true>,
      new GuestAccessWindowService(),
    );
    const actor: AuthenticatedActor = {
      userId: 'admin-a',
      supabaseUserId: 'identity-a',
      email: 'admin@example.test',
      firstName: 'Elena',
      lastName: 'Hart',
      platformRole: null,
      memberships: [
        {
          clientId: 'client-a',
          role: 'CLIENT_ADMIN',
          status: 'ACTIVE',
          permissions: [],
        },
      ],
    };

    await expect(service.send(actor, 'request-a', 'event-a')).resolves.toEqual({ queued: 2 });
    expect(transaction.invitation.create).toHaveBeenCalledTimes(2);
    expect(outbox.create).toHaveBeenCalledTimes(2);
    expect(transaction.invitation.create).toHaveBeenCalledWith({
      data: {
        eventId: 'event-a',
        guestId: 'guest-a',
        status: 'QUEUED',
        expiresAt: new Date('2027-10-14T22:00:00Z'),
      },
    });
  });
});
