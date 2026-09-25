import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../../common/config/environment';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { OutboxService } from '../../../infrastructure/jobs/outbox.service';
import { GuestAccessWindowService } from '../../guest-access/application/guest-access-window.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { InvitationsService } from './invitations.service';
import type { QrCodeService } from './qr-code.service';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
import { EventLifecycleService } from '../../events/domain/event-lifecycle.service';
import type { Prisma } from '@prisma/client';

describe('InvitationsService', () => {
  it('allows event readers to list invitations without a separate invitation-read grant', async () => {
    const event = { id: 'event-a', clientId: 'client-a', slug: 'forum', status: 'PUBLISHED',
      createdByUserId: 'staff-b', startAt: new Date(Date.now() - 86_400_000), endAt: new Date(Date.now() + 86_400_000) };
    const actor: AuthenticatedActor = {
      userId: 'staff-a', supabaseUserId: 'identity-a', email: 'staff@example.test',
      firstName: 'Staff', lastName: 'Member', platformRole: null,
      memberships: [{ clientId: 'client-a', role: 'CLIENT_STAFF', status: 'ACTIVE', permissions: [Permission.EVENT_READ] }],
    };
    const authorization = new AuthorizationService();
    const assert = vi.spyOn(authorization, 'assert');
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      invitation: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new InvitationsService(prisma, authorization, {} as OutboxService,
      {} as QrCodeService, {} as ConfigService<Environment, true>, new GuestAccessWindowService(),
      new EventMutationPolicyService(authorization, new EventLifecycleService()));

    await expect(service.list(actor, event.id)).resolves.toMatchObject({ items: [] });
    expect(assert).toHaveBeenCalledWith(actor, event.clientId, Permission.EVENT_READ);
  });

  it('queues one secure invitation job for every unsent guest', async () => {
    const guests = Array.from({ length: 2_501 }, (_, index) => ({ id: `guest-${index}` }));
    const event = {
      id: 'event-a',
      clientId: 'client-a',
      slug: 'leadership-forum',
      status: 'PUBLISHED',
      createdByUserId: 'admin-a',
      startAt: new Date('2027-10-12T08:00:00Z'),
      endAt: new Date('2027-10-14T18:00:00Z'),
    };
    const transaction = {
      $executeRaw: vi.fn(),
      guest: {
        findMany: vi.fn().mockResolvedValue(guests),
        count: vi.fn().mockResolvedValue(guests.length),
      },
      invitation: {
        createMany: vi.fn<(input: { data: Prisma.InvitationCreateManyInput[] }) => Promise<void>>(),
      },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService;
    const outbox = { createMany: vi.fn<(tx: unknown, inputs: Prisma.OutboxEventCreateManyInput[]) => Promise<void>>() };
    const service = new InvitationsService(
      prisma,
      new AuthorizationService(),
      outbox as unknown as OutboxService,
      {} as QrCodeService,
      { get: vi.fn() } as unknown as ConfigService<Environment, true>,
      new GuestAccessWindowService(),
      new EventMutationPolicyService(new AuthorizationService(), new EventLifecycleService()),
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
          role: 'CLIENT_STAFF',
          status: 'ACTIVE',
          permissions: [Permission.EVENT_CREATE],
        },
      ],
    };

    await expect(service.send(actor, 'request-a', 'event-a')).resolves.toEqual({ queued: 2_501 });
    const invitations = transaction.invitation.createMany.mock.calls.flatMap(([input]) => input.data);
    const jobs = outbox.createMany.mock.calls.flatMap(([, inputs]) => inputs);
    expect(invitations.map(({ guestId }) => guestId)).toEqual(guests.map(({ id }) => id));
    expect(new Set(invitations.map(({ id }) => id)).size).toBe(guests.length);
    expect(jobs.map(({ aggregateId, payload }) => ({ aggregateId, payload }))).toEqual(
      invitations.map(({ id }) => ({ aggregateId: id, payload: { invitationId: id } })),
    );
    expect(invitations[0]).toMatchObject({
        eventId: 'event-a',
        guestId: 'guest-0',
        status: 'QUEUED',
        expiresAt: new Date('2027-10-14T22:00:00Z'),
    });
  });

  it('revokes an old sent link and queues a fresh invitation for one guest', async () => {
    const event = {
      id: 'event-a', clientId: 'client-a', slug: 'leadership-forum', status: 'PUBLISHED',
      startAt: new Date('2027-10-12T08:00:00Z'), endAt: new Date('2027-10-14T18:00:00Z'),
      createdByUserId: 'admin-a',
    };
    const transaction = {
      $executeRaw: vi.fn(),
      guest: { findFirst: vi.fn().mockResolvedValue({ id: 'guest-a' }), findMany: vi.fn().mockResolvedValue([{ id: 'guest-a' }]) },
      invitation: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), createMany: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService;
    const outbox = { createMany: vi.fn() };
    const service = new InvitationsService(prisma, new AuthorizationService(), outbox as unknown as OutboxService,
      {} as QrCodeService, { get: vi.fn() } as unknown as ConfigService<Environment, true>,
      new GuestAccessWindowService(), new EventMutationPolicyService(new AuthorizationService(), new EventLifecycleService()));
    const actor: AuthenticatedActor = {
      userId: 'admin-a', supabaseUserId: 'identity-a', email: 'admin@example.test',
      firstName: 'Elena', lastName: 'Hart', platformRole: null,
      memberships: [{ clientId: 'client-a', role: 'CLIENT_ADMIN', status: 'ACTIVE', permissions: [] }],
    };
    await expect(service.resendGuest(actor, 'request-a', 'event-a', 'guest-a')).resolves.toEqual({ queued: 1 });
    expect(transaction.invitation.updateMany).toHaveBeenCalledWith({
      where: { eventId: 'event-a', guestId: 'guest-a', status: 'SENT' },
      data: expect.objectContaining({ status: 'REVOKED', tokenHash: null, tokenEncrypted: null }) as unknown,
    });
    expect(transaction.guest.findMany).toHaveBeenCalledWith({
      where: { eventId: 'event-a', id: { in: ['guest-a'] }, invitations: { none: { status: { in: ['QUEUED', 'SENT', 'ACCEPTED'] } } } },
      select: { id: true },
    });
    expect(transaction.invitation.createMany).toHaveBeenCalledOnce();
    expect(outbox.createMany).toHaveBeenCalledOnce();
  });
});
