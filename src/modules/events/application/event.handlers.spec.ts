import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { OutboxService } from '../../../infrastructure/jobs/outbox.service';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { EventCompletenessService } from '../domain/event-completeness.service';
import { EventLifecycleService } from '../domain/event-lifecycle.service';
import { EventMutationPolicyService } from '../domain/event-mutation-policy.service';
import { CreateEventDraftHandler, PublishEventHandler } from './event.handlers';
import { CreateEventDraftCommand, PublishEventCommand } from './event.messages';

const actor: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'admin@example.test',
  firstName: 'Avery',
  lastName: 'Stone',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_ADMIN',
      status: 'ACTIVE',
      permissions: [Permission.EVENT_CREATE, Permission.EVENT_PUBLISH],
    },
  ],
};

const readyEvent = {
  id: 'event-a',
  clientId: 'client-a',
  name: 'Leadership Forum',
  category: 'CONFERENCE',
  description: 'A fictional leadership conference.',
  destination: 'Lisbon',
  venue: 'Riverside Hall',
  startAt: new Date('2027-10-12T08:00:00Z'),
  endAt: new Date('2027-10-14T18:00:00Z'),
  timezone: 'Europe/Lisbon',
  organizerName: 'Northstar Events',
  organizerEmail: 'events@example.test',
  status: 'READY',
};

describe('CreateEventDraftHandler', () => {
  it('persists reviewed facts and schedule items in the event transaction', async () => {
    const databaseTransaction = {
      event: {
        create: vi
          .fn<(input: { data: Record<string, unknown> }) => Promise<typeof readyEvent>>()
          .mockResolvedValue(readyEvent),
      },
      eventFact: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      scheduleItem: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      $transaction: vi.fn((work: (transaction: typeof databaseTransaction) => unknown) =>
        work(databaseTransaction),
      ),
    } as unknown as PrismaService;
    const handler = new CreateEventDraftHandler(
      prisma,
      new AuthorizationService(),
      new EventCompletenessService(),
    );

    await handler.execute(
      new CreateEventDraftCommand(actor, 'request-a', {
        clientId: 'client-a',
        name: 'Leadership Forum',
        category: 'CONFERENCE',
        facts: [{ key: 'dress_code', value: 'Business casual', confidence: 0.95 }],
        schedule: [
          {
            title: 'Welcome reception',
            startAt: '2027-10-12T18:00:00.000Z',
            location: 'Riverside Hall',
          },
        ],
      }),
    );

    const eventCreateInput = databaseTransaction.event.create.mock.calls[0]?.[0];
    expect(eventCreateInput?.data).not.toHaveProperty('facts');
    expect(eventCreateInput?.data).not.toHaveProperty('schedule');
    expect(databaseTransaction.eventFact.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            eventId: 'event-a',
            key: 'dress_code',
            sourceType: 'USER_INPUT',
            precedence: 300,
          }),
        ],
      }),
    );
    expect(databaseTransaction.scheduleItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ eventId: 'event-a', title: 'Welcome reception' })],
      }),
    );
  });
});

describe('PublishEventHandler', () => {
  const policy = new EventMutationPolicyService(
    new AuthorizationService(),
    new EventLifecycleService(),
  );
  it('rejects an incomplete event before opening a transaction', async () => {
    const transaction = vi.fn();
    const prisma = {
      event: {
        findUnique: vi.fn().mockResolvedValue({ ...readyEvent, venue: null, destination: null }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const handler = new PublishEventHandler(
      prisma,
      new EventCompletenessService(),
      { create: vi.fn() } as unknown as OutboxService,
      policy,
    );

    await expect(
      handler.execute(new PublishEventCommand(actor, 'request-a', 'event-a')),
    ).rejects.toMatchObject({ code: 'EVENT_VALIDATION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('publishes atomically with an outbox event and audit entry', async () => {
    const databaseTransaction = {
      event: { update: vi.fn().mockResolvedValue({ ...readyEvent, status: 'PUBLISHED' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(readyEvent) },
      $transaction: vi.fn((work: (transaction: typeof databaseTransaction) => unknown) =>
        work(databaseTransaction),
      ),
    } as unknown as PrismaService;
    const outbox = { create: vi.fn().mockResolvedValue({ id: 'outbox-a' }) };
    const handler = new PublishEventHandler(
      prisma,
      new EventCompletenessService(),
      outbox as unknown as OutboxService,
      policy,
    );

    await expect(
      handler.execute(new PublishEventCommand(actor, 'request-a', 'event-a')),
    ).resolves.toMatchObject({ status: 'PUBLISHED', completeness: { ready: true } });
    expect(outbox.create).toHaveBeenCalledWith(
      databaseTransaction,
      expect.objectContaining({ type: 'EVENT_PUBLISHED', eventId: 'event-a' }),
    );
    expect(databaseTransaction.auditLog.create).toHaveBeenCalledOnce();
  });
});
