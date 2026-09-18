import { PrismaClient, type Prisma } from '@prisma/client';
import type { AuthenticatedActor } from '../../src/common/types/request.types';
import type { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { DashboardService } from '../../src/modules/dashboard/application/dashboard.service';
import { EventCompletenessService } from '../../src/modules/events/domain/event-completeness.service';

// Opt-in, read-only checks against an existing database. No seed or schema changes.
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Joined read queries', () => {
  const createPrisma = () =>
    new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      log: [{ emit: 'event', level: 'query' }],
    });
  let prisma: ReturnType<typeof createPrisma>;
  let selects = 0;
  const eventInclude = {
    _count: { select: { guests: true, documents: true, invitations: true } },
    client: { select: { id: true, name: true } },
    createdBy: {
      select: { id: true, firstName: true, lastName: true, email: true },
    },
  } satisfies Prisma.EventInclude;

  beforeAll(async () => {
    prisma = createPrisma();
    prisma.$on('query', ({ query }) => {
      if (/^SELECT\b/i.test(query)) selects += 1;
    });
    await prisma.$connect();
  });
  afterAll(() => prisma?.$disconnect());

  it('returns the same account, memberships and permissions with one SELECT', async () => {
    const args = {
      take: 5,
      orderBy: { id: 'asc' },
      include: {
        memberships: {
          orderBy: { id: 'asc' },
          include: {
            permissions: { orderBy: { permission: 'asc' } },
            client: { select: { status: true } },
          },
        },
      },
    } satisfies Prisma.UserFindManyArgs;
    const original = await prisma.user.findMany({
      ...args,
      relationLoadStrategy: 'query',
    });
    selects = 0;
    const joined = await prisma.user.findMany({
      ...args,
      relationLoadStrategy: 'join',
    });
    expect(selects).toBe(1);
    // Assert a boolean so failures never print account records.
    expect(JSON.stringify(joined) === JSON.stringify(original)).toBe(true);
  }, 30_000);

  it('preserves event relations, counts, tenant scope and cursor pages with one SELECT', async () => {
    const scope = await prisma.event.findFirst({ select: { clientId: true } });
    const args = {
      where: scope ? { clientId: scope.clientId } : {},
      take: 2,
      orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
      include: eventInclude,
    } satisfies Prisma.EventFindManyArgs;
    const original = await prisma.event.findMany({
      ...args,
      relationLoadStrategy: 'query',
    });
    selects = 0;
    const joined = await prisma.event.findMany({
      ...args,
      relationLoadStrategy: 'join',
    });
    expect(selects).toBe(1);
    expect(JSON.stringify(joined) === JSON.stringify(original)).toBe(true);
    expect(joined.every((event) => event.clientId === scope?.clientId)).toBe(true);

    if (joined.length) {
      const nextArgs = { ...args, skip: 1, cursor: { id: joined[0].id } };
      const originalNext = await prisma.event.findMany({
        ...nextArgs,
        relationLoadStrategy: 'query',
      });
      selects = 0;
      const joinedNext = await prisma.event.findMany({
        ...nextArgs,
        relationLoadStrategy: 'join',
      });
      expect(selects).toBe(1);
      expect(JSON.stringify(joinedNext) === JSON.stringify(originalNext)).toBe(true);
      expect(joinedNext.some((event) => event.id === joined[0].id)).toBe(false);
    }
  }, 30_000);

  it('runs UUID-scoped dashboard metrics and returns only authorized clients', async () => {
    const client = await prisma.client.findFirst({ select: { id: true, status: true } });
    const actor: AuthenticatedActor = {
      userId: '00000000-0000-4000-8000-000000000001',
      supabaseUserId: '00000000-0000-4000-8000-000000000002',
      email: 'probe@example.test',
      firstName: 'Read',
      lastName: 'Probe',
      platformRole: null,
      memberships: client
        ? [{ clientId: client.id, role: 'CLIENT_ADMIN', status: 'ACTIVE', permissions: [] }]
        : [],
    };
    const service = new DashboardService(
      prisma as unknown as PrismaService,
      new EventCompletenessService(),
    );
    const result = await service.get(actor);
    expect(result.metrics.clients).toBe(client ? 1 : 0);
    expect(result.metrics.activeClients).toBe(client?.status === 'ACTIVE' ? 1 : 0);
    expect(result.metrics.events).toBe(
      client ? await prisma.event.count({ where: { clientId: client.id } }) : 0,
    );
    expect(result.recentEvents.every((event) => event.clientId === client?.id)).toBe(true);
    expect(result.recentActivity.every((item) => item.clientId === client?.id)).toBe(true);

    const empty = await service.get({ ...actor, memberships: [] });
    expect(empty.metrics).toEqual({
      clients: 0,
      activeClients: 0,
      events: 0,
      upcoming: 0,
      drafts: 0,
      published: 0,
    });
    expect(empty.recentEvents).toEqual([]);
    expect(empty.recentActivity).toEqual([]);
  }, 30_000);
});
