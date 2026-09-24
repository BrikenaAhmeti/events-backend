import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuditService } from './audit.service';

const clientAdministrator: AuthenticatedActor = {
  userId: '2d341f45-e409-4e84-aa89-c621e25e7043',
  supabaseUserId: 'identity-admin',
  email: 'admin@example.test',
  firstName: 'Avery',
  lastName: 'Stone',
  platformRole: null,
  memberships: [
    {
      clientId: '041a6048-cd9a-47cd-8267-c6ac436ed70c',
      role: 'CLIENT_ADMIN',
      status: 'ACTIVE',
      permissions: [],
    },
  ],
};

describe('AuditService', () => {
  it('labels super admin actors without returning their email address', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'log-a', actor: { id: 'super-a', firstName: 'Mara', lastName: 'Ellis',
        email: 'super.admin@example.test', platformRole: 'SUPER_ADMIN' } },
      { id: 'log-b', actor: { id: 'staff-a', firstName: 'Jamie', lastName: 'Lee',
        email: 'jamie@example.test', platformRole: null } },
    ]);
    const service = new AuditService({ auditLog: { findMany } } as unknown as PrismaService);

    const result = await service.list(clientAdministrator, { limit: 30 });

    expect(result.items[0]?.actor).toMatchObject({ platformRole: 'SUPER_ADMIN', email: null });
    expect(result.items[1]?.actor).toMatchObject({ platformRole: null, email: 'jamie@example.test' });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      select: { actor: { select: { platformRole: true } } },
    });
  });

  it('keeps super admins out of the team member directory and omits directory emails', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { role: 'CLIENT_ADMIN', user: { id: 'super-a', firstName: 'Mara', lastName: 'Ellis', platformRole: 'SUPER_ADMIN' } },
      { role: 'CLIENT_STAFF', user: { id: 'staff-a', firstName: 'Jamie', lastName: 'Lee', platformRole: null } },
    ]);
    const service = new AuditService({ clientMembership: { findMany } } as unknown as PrismaService);

    const result = await service.actors(clientAdministrator);

    expect(result).toEqual([{ id: 'staff-a', firstName: 'Jamie', lastName: 'Lee', role: 'CLIENT_STAFF' }]);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { user: { platformRole: null } },
      select: { user: { select: { platformRole: true } } },
    });
  });

  it('scopes activity to the client administrator and applies staff and time filters', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new AuditService({
      auditLog: { findMany },
    } as unknown as PrismaService);

    await service.list(clientAdministrator, {
      actorUserId: '4367d4d4-43e2-49ef-a882-ab0135640506',
      from: '2026-09-01T08:00:00.000Z',
      to: '2026-09-18T18:00:00.000Z',
      limit: 30,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: { in: ['041a6048-cd9a-47cd-8267-c6ac436ed70c'] },
          actorUserId: '4367d4d4-43e2-49ef-a882-ab0135640506',
          createdAt: {
            gte: new Date('2026-09-01T08:00:00.000Z'),
            lte: new Date('2026-09-18T18:00:00.000Z'),
          },
        },
      }),
    );
  });

  it('rejects client staff even when they can read events', async () => {
    const service = new AuditService({} as PrismaService);
    const staff: AuthenticatedActor = {
      ...clientAdministrator,
      memberships: [
        {
          ...clientAdministrator.memberships[0],
          role: 'CLIENT_STAFF',
          permissions: ['EVENT_READ'],
        },
      ],
    };

    await expect(service.list(staff, { limit: 30 })).rejects.toMatchObject({
      code: 'AUDIT_ACCESS_REQUIRED',
    });
  });

  it('lets a platform administrator view all clients or select one', async () => {
    const findMany = vi
      .fn<(input: { where: Record<string, unknown> }) => Promise<unknown[]>>()
      .mockResolvedValue([]);
    const service = new AuditService({
      auditLog: { findMany },
    } as unknown as PrismaService);
    const platformAdministrator: AuthenticatedActor = {
      ...clientAdministrator,
      platformRole: 'SUPER_ADMIN',
      memberships: [],
    };

    await service.list(platformAdministrator, { limit: 30 });
    await service.list(platformAdministrator, {
      clientId: '7cae8aa5-a343-4085-bb96-2388799d7253',
      limit: 30,
    });

    expect(findMany.mock.calls[0]?.[0].where).toEqual({});
    expect(findMany.mock.calls[1]?.[0].where).toEqual({
      clientId: { in: ['7cae8aa5-a343-4085-bb96-2388799d7253'] },
    });
  });
});
