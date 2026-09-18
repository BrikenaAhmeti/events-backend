// Read-only latency probe. Never prints credentials, SQL parameters or application records.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { DashboardService } = require('../dist/modules/dashboard/application/dashboard.service');
const {
  EventCompletenessService,
} = require('../dist/modules/events/domain/event-completeness.service');
const url = new URL(process.env.DATABASE_URL);
if (process.env.PROFILE_POOL_SIZE)
  url.searchParams.set('connection_limit', process.env.PROFILE_POOL_SIZE);
const db = new PrismaClient({
  datasources: { db: { url: url.toString() } },
  log: [{ emit: 'event', level: 'query' }],
});
let queries = [];
db.$on('query', (e) =>
  queries.push({
    ms: e.duration,
    isRead: /^(SELECT|WITH)\b/i.test(e.query.trim()),
  }),
);
async function measure(label, work) {
  queries = [];
  const start = performance.now();
  await work();
  console.log(
    JSON.stringify({
      label,
      ms: Math.round(performance.now() - start),
      statements: queries.length,
      reads: queries.filter(({ isRead }) => isRead).length,
    }),
  );
}
const relations = process.env.PROFILE_RELATIONS
  ? { relationLoadStrategy: process.env.PROFILE_RELATIONS }
  : {};
// Apply the comparison strategy to the real dashboard service as well.
const dashboardDb = db.$extends({
  query: {
    event: {
      findMany({ args, query }) {
        return query({ ...args, ...relations });
      },
    },
  },
});
const dashboard = new DashboardService(dashboardDb, new EventCompletenessService());
const platformActor = { platformRole: 'SUPER_ADMIN', memberships: [] };
const user = () =>
  db.user.findFirst({
    ...relations,
    include: {
      memberships: {
        include: { permissions: true, client: { select: { status: true } } },
      },
    },
  });
const events = () =>
  db.event.findMany({
    ...relations,
    take: 21,
    orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
    include: {
      _count: { select: { guests: true, documents: true, invitations: true } },
      client: { select: { id: true, name: true } },
      createdBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  });
(async () => {
  console.log(
    JSON.stringify({
      poolSize: url.searchParams.get('connection_limit'),
      relations: process.env.PROFILE_RELATIONS ?? 'default',
    }),
  );
  await measure('connect', () => db.$queryRaw`SELECT 1`);
  await measure('warm ping', () => db.$queryRaw`SELECT 1`);
  await measure('account and permissions', user);
  await measure('events list', events);
  await measure('events page requests', () =>
    Promise.all([
      user().then(events),
      user().then(() =>
        db.client.findMany({
          take: 500,
          orderBy: { name: 'asc' },
          select: { id: true, name: true, slug: true, status: true },
        }),
      ),
      user().then(() =>
        db.user.findMany({
          where: { createdEvents: { some: {} } },
          take: 200,
          orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
          select: { id: true, firstName: true, lastName: true, email: true },
        }),
      ),
    ]),
  );
  await measure('dashboard request', async () => {
    await user();
    await dashboard.get(platformActor);
  });
  const client = await db.client.findFirst({ select: { id: true } });
  if (client) {
    await measure('client dashboard request', async () => {
      await user();
      await dashboard.get({
        platformRole: null,
        memberships: [
          {
            clientId: client.id,
            role: 'CLIENT_ADMIN',
            status: 'ACTIVE',
            permissions: [],
          },
        ],
      });
    });
  }
})()
  .catch((e) => {
    console.error(JSON.stringify({ error: e.code ?? e.name }));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
