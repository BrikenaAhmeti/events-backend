import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { OutboxService } from '../../../infrastructure/jobs/outbox.service';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { EventCompletenessService } from '../domain/event-completeness.service';
import { EventLifecycleService } from '../domain/event-lifecycle.service';
import { EventMutationPolicyService } from '../domain/event-mutation-policy.service';
import {
  AddScheduleItemHandler,
  CreateEventDraftHandler,
  GetEventsHandler,
  PublishEventHandler,
  UpdateEventDetailsHandler,
} from './event.handlers';
import {
  AddScheduleItemCommand,
  CreateEventDraftCommand,
  GetEventsQuery,
  PublishEventCommand,
  UpdateEventDetailsCommand,
} from './event.messages';

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

const readyInput = {
  clientId: 'client-a',
  name: 'Leadership Forum',
  category: 'CONFERENCE',
  description: 'A fictional leadership conference.',
  destination: 'Lisbon',
  venue: 'Riverside Hall',
  startAt: '2027-10-12T08:00:00.000Z',
  endAt: '2027-10-14T18:00:00.000Z',
  timezone: 'Europe/Lisbon',
  organizerName: 'Northstar Events',
  organizerEmail: 'events@example.test',
};

describe('CreateEventDraftHandler', () => {
  it('blocks event creation until extracted document details are confirmed', async () => {
    const transaction = vi.fn();
    const handler = new CreateEventDraftHandler(
      {
        conversation: { findFirst: vi.fn().mockResolvedValue({
          id: 'setup-a', draft: { documentReviewPending: true },
        }) },
        $transaction: transaction,
      } as unknown as PrismaService,
      new AuthorizationService(),
      new EventCompletenessService(),
    );

    await expect(handler.execute(new CreateEventDraftCommand(actor, 'request-pending', {
      ...readyInput,
      setupSessionId: '9f47fbca-c63c-4ea0-af61-c74390c238b8',
    }))).rejects.toMatchObject({ code: 'EVENT_DOCUMENT_REVIEW_REQUIRED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('saves guests collected in the setup chat when creating the event', async () => {
    const createGuests = vi.fn().mockResolvedValue({ count: 2 });
    const transaction = {
      event: { create: vi.fn().mockResolvedValue(readyEvent) },
      guest: { createMany: createGuests },
      conversation: { update: vi.fn().mockResolvedValue({ id: 'setup-a' }) },
      document: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'setup-a',
          draft: { guests: [
            { fullName: 'Alex Morgan', email: 'Alex@Example.test' },
            { fullName: 'Sam Lee', email: 'sam@example.test' },
          ] },
        }),
      },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService;
    const handler = new CreateEventDraftHandler(
      prisma,
      new AuthorizationService(),
      new EventCompletenessService(),
    );

    await handler.execute(new CreateEventDraftCommand(actor, 'request-guests', {
      ...readyInput,
      setupSessionId: '9f47fbca-c63c-4ea0-af61-c74390c238b8',
    }));

    expect(createGuests).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [
        expect.objectContaining({ fullName: 'Alex Morgan', normalizedEmail: 'alex@example.test' }),
        expect.objectContaining({ fullName: 'Sam Lee', normalizedEmail: 'sam@example.test' }),
      ],
    }));
  });

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
        ...readyInput,
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

  it('records the actual platform administrator while assigning the event to the selected client', async () => {
    const platformAdministrator: AuthenticatedActor = {
      ...actor,
      userId: 'platform-admin',
      platformRole: 'SUPER_ADMIN',
      memberships: [],
    };
    const createEvent = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<typeof readyEvent>>()
      .mockResolvedValue({ ...readyEvent, id: 'event-b', clientId: 'client-b' });
    const createAudit = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'audit-b' });
    const databaseTransaction = {
      event: { create: createEvent },
      auditLog: { create: createAudit },
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
      new CreateEventDraftCommand(platformAdministrator, 'request-b', {
        ...readyInput,
        clientId: 'client-b',
      }),
    );

    expect(createEvent.mock.calls[0]?.[0].data).toMatchObject({
      clientId: 'client-b',
      createdByUserId: 'platform-admin',
    });
    expect(createAudit.mock.calls[0]?.[0].data).toMatchObject({
      actorUserId: 'platform-admin',
      clientId: 'client-b',
      eventId: 'event-b',
    });
  });

  it('does not create an event while mandatory details are missing', async () => {
    const transaction = vi.fn();
    const handler = new CreateEventDraftHandler(
      { $transaction: transaction } as unknown as PrismaService,
      new AuthorizationService(),
      new EventCompletenessService(),
    );

    await expect(
      handler.execute(
        new CreateEventDraftCommand(actor, 'request-incomplete', {
          clientId: 'client-a',
          name: 'Leadership Forum',
          category: 'CONFERENCE',
        }),
      ),
    ).rejects.toMatchObject({ code: 'EVENT_VALIDATION_FAILED' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('promotes setup files into the event knowledge pipeline and completes the hidden setup chat', async () => {
    const databaseTransaction = {
      event: { create: vi.fn().mockResolvedValue(readyEvent) },
      eventFact: { createMany: vi.fn() },
      scheduleItem: { createMany: vi.fn() },
      document: {
        findMany: vi.fn().mockResolvedValue([{ id: 'document-a' }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      backgroundJob: { upsert: vi.fn().mockResolvedValue({ id: 'job-a' }) },
      conversation: { update: vi.fn().mockResolvedValue({ id: 'setup-a' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'setup-a' }) },
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
      new CreateEventDraftCommand(actor, 'request-setup', {
        ...readyInput,
        setupSessionId: '9f47fbca-c63c-4ea0-af61-c74390c238b8',
      }),
    );

    expect(databaseTransaction.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { eventId: readyEvent.id, processingStatus: 'QUEUED' },
      }),
    );
    const jobInput = databaseTransaction.backgroundJob.upsert.mock.calls[0]?.[0] as unknown as {
      create: { type: string; eventId: string };
    };
    expect(jobInput.create).toMatchObject({ type: 'DOCUMENT_PROCESS', eventId: readyEvent.id });
    const conversationInput = databaseTransaction.conversation.update.mock.calls[0]?.[0] as unknown as {
      data: { eventId: string; state: string };
    };
    expect(conversationInput.data).toMatchObject({ eventId: readyEvent.id, state: 'COMPLETED' });
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

describe('UpdateEventDetailsHandler', () => {
  it('persists flexible titled event details without fixed information fields', async () => {
    const updateEvent = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<typeof readyEvent>>()
      .mockResolvedValue(readyEvent);
    const upsertFact = vi
      .fn<
        (input: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => Promise<{ id: string }>
      >()
      .mockResolvedValue({ id: 'fact-a' });
    const databaseTransaction = {
      event: { update: updateEvent },
      eventFact: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: upsertFact,
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      event: {
        findUnique: vi.fn().mockResolvedValue({ ...readyEvent, createdByUserId: actor.userId }),
      },
      $transaction: vi.fn((work: (transaction: typeof databaseTransaction) => unknown) =>
        work(databaseTransaction),
      ),
    } as unknown as PrismaService;
    const authorization = new AuthorizationService();
    const lifecycle = new EventLifecycleService();
    const handler = new UpdateEventDetailsHandler(
      prisma,
      new EventCompletenessService(),
      new EventMutationPolicyService(authorization, lifecycle),
    );

    await handler.execute(
      new UpdateEventDetailsCommand(actor, 'request-details', readyEvent.id, {
        facts: [
          {
            key: 'Shuttle pickup',
            value: 'Meet in the hotel lobby at 08:30.',
            confidence: 1,
          },
        ],
      }),
    );

    expect(upsertFact.mock.calls[0]?.[0].create).toMatchObject({
      key: 'Shuttle pickup',
      value: 'Meet in the hotel lobby at 08:30.',
      sourceType: 'USER_INPUT',
    });
    expect(updateEvent.mock.calls[0]?.[0].data).not.toHaveProperty('facts');
  });
});

describe('AddScheduleItemHandler', () => {
  it('saves the schedule item and its audit record in one transaction', async () => {
    const item = {
      id: 'schedule-a',
      eventId: 'event-a',
      title: 'Opening session',
      startAt: new Date('2027-10-12T09:00:00.000Z'),
    };
    const databaseTransaction = {
      scheduleItem: { create: vi.fn().mockResolvedValue(item) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      event: {
        findUnique: vi.fn().mockResolvedValue({
          ...readyEvent,
          createdByUserId: actor.userId,
        }),
      },
      $transaction: vi.fn((work: (transaction: typeof databaseTransaction) => unknown) =>
        work(databaseTransaction),
      ),
    } as unknown as PrismaService;
    const authorization = new AuthorizationService();
    const handler = new AddScheduleItemHandler(
      prisma,
      new EventMutationPolicyService(authorization, new EventLifecycleService()),
    );

    await expect(
      handler.execute(
        new AddScheduleItemCommand(actor, 'request-schedule', 'event-a', {
          title: 'Opening session',
          startAt: '2027-10-12T09:00:00.000Z',
        }),
      ),
    ).resolves.toEqual(item);
    expect(databaseTransaction.scheduleItem.create).toHaveBeenCalledOnce();
    const auditInput = databaseTransaction.auditLog.create.mock.calls[0]?.[0] as unknown as {
      data: { action: string; actorUserId: string; entityId: string };
    };
    expect(auditInput.data).toMatchObject({
      action: 'SCHEDULE_ITEM_ADDED',
      actorUserId: actor.userId,
      entityId: item.id,
    });
  });
});

describe('GetEventsHandler', () => {
  it('shows client staff every event in their company without a creator restriction', async () => {
    const findMany = vi
      .fn<(input: { where: Record<string, unknown> }) => Promise<unknown[]>>()
      .mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaService;
    const authorization = new AuthorizationService();
    const lifecycle = new EventLifecycleService();
    const handler = new GetEventsHandler(
      prisma,
      authorization,
      new EventCompletenessService(),
      lifecycle,
      new EventMutationPolicyService(authorization, lifecycle),
    );
    const staffActor: AuthenticatedActor = {
      ...actor,
      memberships: [
        {
          clientId: 'client-a',
          role: 'CLIENT_STAFF',
          status: 'ACTIVE',
          permissions: [Permission.EVENT_READ],
        },
      ],
    };

    await handler.execute(new GetEventsQuery(staffActor, { clientId: 'client-a', limit: 20 }));

    expect(findMany.mock.calls[0]?.[0].where).toEqual({ clientId: 'client-a' });
  });

  it('combines selected lifecycle and workflow statuses as multi-value filters', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { event: { findMany } } as unknown as PrismaService;
    const authorization = new AuthorizationService();
    const lifecycle = new EventLifecycleService();
    const handler = new GetEventsHandler(
      prisma,
      authorization,
      new EventCompletenessService(),
      lifecycle,
      new EventMutationPolicyService(authorization, lifecycle),
    );

    await handler.execute(
      new GetEventsQuery(actor, {
        clientId: 'client-a',
        limit: 20,
        lifecycle: ['UPCOMING', 'PAST'],
        status: ['READY', 'PUBLISHED'],
      }),
    );

    const request = findMany.mock.calls[0]?.[0] as unknown as {
      where: {
        clientId: string;
        status: { in: string[] };
        AND: Array<{
          OR: Array<{
            status: { not: string };
            startAt?: { gt: Date };
            endAt?: { lt: Date };
          }>;
        }>;
      };
    };
    expect(request.where.clientId).toBe('client-a');
    expect(request.where.status).toEqual({ in: ['READY', 'PUBLISHED'] });
    expect(request.where.AND[0]?.OR).toHaveLength(2);
    expect(request.where.AND[0]?.OR[0]).toMatchObject({ status: { not: 'CANCELLED' } });
    expect(request.where.AND[0]?.OR[0]?.startAt?.gt).toBeInstanceOf(Date);
    expect(request.where.AND[0]?.OR[1]).toMatchObject({ status: { not: 'CANCELLED' } });
    expect(request.where.AND[0]?.OR[1]?.endAt?.lt).toBeInstanceOf(Date);
  });
});
