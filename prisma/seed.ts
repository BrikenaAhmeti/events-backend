import { PrismaClient, type PlatformRole } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const prisma = new PrismaClient();

const identities = {
  superAdmin: '00000000-0000-4000-8000-000000000001',
  clientAdmin: '00000000-0000-4000-8000-000000000002',
  clientStaff: '00000000-0000-4000-8000-000000000003',
};

async function resolveIdentity(
  email: string,
  password: string | undefined,
  fallback: string,
): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !password) return fallback;
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await auth.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const existing = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (existing) return existing.id;
    if (data.users.length < 100) break;
  }
  const { data, error } = await auth.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('SupabaseUserCreationFailed');
  return data.user.id;
}

async function upsertUser(input: {
  email: string;
  password?: string;
  fallbackId: string;
  firstName: string;
  lastName: string;
  platformRole?: PlatformRole;
}) {
  const supabaseUserId = await resolveIdentity(input.email, input.password, input.fallbackId);
  return prisma.user.upsert({
    where: { email: input.email },
    create: {
      supabaseUserId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      platformRole: input.platformRole,
    },
    update: {
      supabaseUserId,
      firstName: input.firstName,
      lastName: input.lastName,
      platformRole: input.platformRole,
      status: 'ACTIVE',
    },
  });
}

async function main(): Promise<void> {
  const adminOnly = process.env.SEED_SCOPE === 'admin';
  if (
    adminOnly &&
    (!process.env.DATABASE_URL ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SECRET_KEY ||
      !process.env.DEMO_SUPER_ADMIN_PASSWORD)
  ) {
    throw new Error(
      'AdminSeedRequiresDatabaseUrlSupabaseUrlSupabaseSecretKeyAndDemoSuperAdminPassword',
    );
  }
  const superAdmin = await upsertUser({
    email: process.env.DEMO_SUPER_ADMIN_EMAIL ?? 'super.admin@example.test',
    password: process.env.DEMO_SUPER_ADMIN_PASSWORD,
    fallbackId: identities.superAdmin,
    firstName: 'Mara',
    lastName: 'Ellis',
    platformRole: 'SUPER_ADMIN',
  });
  if (adminOnly) return;
  const clientAdmin = await upsertUser({
    email: process.env.DEMO_CLIENT_ADMIN_EMAIL ?? 'client.admin@example.test',
    password: process.env.DEMO_CLIENT_ADMIN_PASSWORD,
    fallbackId: identities.clientAdmin,
    firstName: 'Elena',
    lastName: 'Hart',
  });
  const clientStaff = await upsertUser({
    email: process.env.DEMO_CLIENT_STAFF_EMAIL ?? 'client.staff@example.test',
    password: process.env.DEMO_CLIENT_STAFF_PASSWORD,
    fallbackId: identities.clientStaff,
    firstName: 'Theo',
    lastName: 'James',
  });
  const client = await prisma.client.upsert({
    where: { slug: 'northstar-events-demo' },
    create: {
      name: 'Northstar Events',
      slug: 'northstar-events-demo',
      contactEmail: 'hello@northstar.example.test',
    },
    update: { name: 'Northstar Events', status: 'ACTIVE' },
  });
  await prisma.clientMembership.upsert({
    where: { userId_clientId: { userId: clientAdmin.id, clientId: client.id } },
    create: {
      userId: clientAdmin.id,
      clientId: client.id,
      role: 'CLIENT_ADMIN',
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
    update: { role: 'CLIENT_ADMIN', status: 'ACTIVE' },
  });
  const staffMembership = await prisma.clientMembership.upsert({
    where: { userId_clientId: { userId: clientStaff.id, clientId: client.id } },
    create: {
      userId: clientStaff.id,
      clientId: client.id,
      role: 'CLIENT_STAFF',
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
    update: { role: 'CLIENT_STAFF', status: 'ACTIVE' },
  });
  const staffPermissions = [
    'EVENT_CREATE',
    'EVENT_READ',
    'EVENT_EDIT',
    'DOCUMENT_UPLOAD',
    'GUEST_READ',
    'GUEST_MANAGE',
    'GUEST_IMPORT',
    'INVITATION_READ',
  ];
  await prisma.clientMembershipPermission.deleteMany({
    where: { membershipId: staffMembership.id },
  });
  await prisma.clientMembershipPermission.createMany({
    data: staffPermissions.map((permission) => ({ membershipId: staffMembership.id, permission })),
  });

  const mallorca = await prisma.event.upsert({
    where: { slug: 'presidents-club-mallorca-demo' },
    create: {
      clientId: client.id,
      createdByUserId: clientAdmin.id,
      name: 'Presidents Club Mallorca',
      slug: 'presidents-club-mallorca-demo',
      category: 'CORPORATE_INCENTIVE',
      description:
        'A four-day recognition journey for this year’s fictional Presidents Club cohort.',
      destination: 'Palma de Mallorca, Spain',
      venue: 'Maris Cove Hotel',
      startAt: new Date('2027-06-10T13:00:00.000Z'),
      endAt: new Date('2027-06-14T10:00:00.000Z'),
      timezone: 'Europe/Madrid',
      organizerName: 'Northstar Guest Services',
      organizerEmail: 'mallorca@northstar.example.test',
      status: 'PUBLISHED',
      configuration: { guestListRequiredForPublish: false },
    },
    update: { createdByUserId: clientAdmin.id, status: 'PUBLISHED' },
  });
  await prisma.scheduleItem.deleteMany({ where: { eventId: mallorca.id } });
  await prisma.scheduleItem.createMany({
    data: [
      {
        eventId: mallorca.id,
        title: 'Airport welcome and transfers',
        startAt: new Date('2027-06-10T13:00:00.000Z'),
        endAt: new Date('2027-06-10T17:00:00.000Z'),
        location: 'Palma Airport arrivals hall',
        category: 'TRANSPORT',
      },
      {
        eventId: mallorca.id,
        title: 'Welcome dinner',
        startAt: new Date('2027-06-10T18:30:00.000Z'),
        endAt: new Date('2027-06-10T21:30:00.000Z'),
        location: 'Maris Cove terrace',
        category: 'MEAL',
      },
      {
        eventId: mallorca.id,
        title: 'Tramuntana discovery',
        startAt: new Date('2027-06-11T07:30:00.000Z'),
        endAt: new Date('2027-06-11T15:00:00.000Z'),
        location: 'Hotel lobby meeting point',
        category: 'ACTIVITY',
      },
      {
        eventId: mallorca.id,
        title: 'Presidents Gala',
        startAt: new Date('2027-06-13T18:00:00.000Z'),
        endAt: new Date('2027-06-13T22:00:00.000Z'),
        location: 'Mirador Courtyard',
        category: 'GALA',
      },
    ],
  });
  const mallorcaFacts = [
    ['breakfast', 'Breakfast is served from 07:00 to 10:30 in the Olive Room.'],
    ['gala_dress_code', 'Cocktail attire with a light layer for the outdoor courtyard.'],
    ['emergency_contact', 'Northstar duty manager: +34 600 555 019.'],
    ['departure_meeting_point', 'Departure coaches leave from the Maris Cove Hotel lobby.'],
  ];
  for (const [key, value] of mallorcaFacts)
    await prisma.eventFact.upsert({
      where: { eventId_key: { eventId: mallorca.id, key } },
      create: { eventId: mallorca.id, key, value, sourceType: 'SYSTEM', precedence: 300 },
      update: { value, sourceType: 'SYSTEM', precedence: 300 },
    });
  const mallorcaGuests = [
    ['Avery Stone', 'avery.stone@example.test', 'Juniper Works'],
    ['Mina Cole', 'mina.cole@example.test', 'Copper Peak'],
    ['Ravi Bell', 'ravi.bell@example.test', 'Arc & Field'],
  ];
  for (const [fullName, email, company] of mallorcaGuests)
    await prisma.guest.upsert({
      where: { eventId_normalizedEmail: { eventId: mallorca.id, normalizedEmail: email } },
      create: { eventId: mallorca.id, fullName, email, normalizedEmail: email, company },
      update: { fullName, company },
    });

  const forum = await prisma.event.upsert({
    where: { slug: 'global-leadership-forum-demo' },
    create: {
      clientId: client.id,
      createdByUserId: clientStaff.id,
      name: 'Global Leadership Forum',
      slug: 'global-leadership-forum-demo',
      category: 'CONFERENCE',
      description:
        'A fictional two-day forum for leaders exploring resilient organizations and responsible growth.',
      destination: 'Copenhagen, Denmark',
      venue: 'Harbor House Conference Centre',
      startAt: new Date('2027-09-22T06:00:00.000Z'),
      endAt: new Date('2027-09-23T16:00:00.000Z'),
      timezone: 'Europe/Copenhagen',
      organizerName: 'Forum Delegate Services',
      organizerEmail: 'forum@northstar.example.test',
      status: 'PUBLISHED',
      configuration: { guestListRequiredForPublish: false },
    },
    update: { createdByUserId: clientStaff.id, status: 'PUBLISHED' },
  });
  await prisma.scheduleItem.deleteMany({ where: { eventId: forum.id } });
  await prisma.scheduleItem.createMany({
    data: [
      {
        eventId: forum.id,
        title: 'Registration and breakfast',
        startAt: new Date('2027-09-22T06:00:00.000Z'),
        endAt: new Date('2027-09-22T07:30:00.000Z'),
        location: 'Harbor House atrium',
        category: 'REGISTRATION',
      },
      {
        eventId: forum.id,
        title: 'Opening keynote: Leading through uncertainty',
        startAt: new Date('2027-09-22T07:30:00.000Z'),
        endAt: new Date('2027-09-22T08:30:00.000Z'),
        location: 'Tide Hall',
        category: 'KEYNOTE',
      },
      {
        eventId: forum.id,
        title: 'Responsible growth roundtable',
        startAt: new Date('2027-09-22T12:00:00.000Z'),
        endAt: new Date('2027-09-22T13:00:00.000Z'),
        location: 'Compass Room',
        category: 'SESSION',
      },
      {
        eventId: forum.id,
        title: 'Harbor networking reception',
        startAt: new Date('2027-09-22T16:00:00.000Z'),
        endAt: new Date('2027-09-22T18:00:00.000Z'),
        location: 'North Quay',
        category: 'NETWORKING',
      },
    ],
  });
  const forumFacts = [
    ['registration', 'Registration is in the Harbor House atrium from 08:00.'],
    ['wifi', 'Network: ForumGuest. The access code is printed on delegate badges.'],
    [
      'keynote_speaker',
      'The opening keynote is delivered by fictional organizational researcher Dr. Simone Vale.',
    ],
    ['lunch', 'Lunch is served in the Gallery from 12:30 to 14:00.'],
  ];
  for (const [key, value] of forumFacts)
    await prisma.eventFact.upsert({
      where: { eventId_key: { eventId: forum.id, key } },
      create: { eventId: forum.id, key, value, sourceType: 'SYSTEM', precedence: 300 },
      update: { value, sourceType: 'SYSTEM', precedence: 300 },
    });
  const delegates = [
    ['Jordan Reed', 'jordan.reed@example.test', 'Lumen North'],
    ['Nora Kim', 'nora.kim@example.test', 'Signal Grove'],
    ['Samir Quinn', 'samir.quinn@example.test', 'Meridian Labs'],
    ['Iris Webb', 'iris.webb@example.test', 'Kindred Systems'],
  ];
  for (const [fullName, email, company] of delegates)
    await prisma.guest.upsert({
      where: { eventId_normalizedEmail: { eventId: forum.id, normalizedEmail: email } },
      create: { eventId: forum.id, fullName, email, normalizedEmail: email, company },
      update: { fullName, company },
    });
  await prisma.auditLog.deleteMany({
    where: {
      actorUserId: superAdmin.id,
      clientId: client.id,
      action: 'DEMO_DATA_SEEDED',
      entityType: 'Client',
      entityId: client.id,
      requestId: 'development-seed',
    },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: superAdmin.id,
      clientId: client.id,
      action: 'DEMO_DATA_SEEDED',
      entityType: 'Client',
      entityId: client.id,
      requestId: 'development-seed',
      metadata: { scenarios: [mallorca.name, forum.name] },
    },
  });
}

void main().finally(async () => prisma.$disconnect());
