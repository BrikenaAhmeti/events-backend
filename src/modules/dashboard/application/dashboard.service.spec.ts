import type { Prisma } from '@prisma/client';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { EventLifecycleService } from '../../events/domain/event-lifecycle.service';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { DashboardService } from './dashboard.service';

const actor: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'operator@example.test',
  firstName: 'Event',
  lastName: 'Operator',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_STAFF',
      status: 'ACTIVE',
      permissions: [Permission.EVENT_READ],
    },
  ],
};

describe('DashboardService', () => {
  it('loads all counters in one scoped query', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        clients: 1,
        activeClients: 1,
        events: 2,
        upcoming: 1,
        drafts: 1,
        published: 1,
      },
    ]);
    const eventFindMany = vi.fn().mockResolvedValue([]);
    const activityFindMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw: queryRaw,
      event: { findMany: eventFindMany },
      auditLog: { findMany: activityFindMany },
    } as unknown as PrismaService;
    const service = new DashboardService(prisma, {
      evaluate: vi.fn(),
    } as unknown as EventCompletenessService,
    new EventLifecycleService(),
    new EventMutationPolicyService(new AuthorizationService(), new EventLifecycleService()));

    const result = await service.get(actor);
    const metricsQuery = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(metricsQuery.values).toContain('client-a');
    expect(eventFindMany).toHaveBeenCalledOnce();
    expect(activityFindMany).toHaveBeenCalledOnce();
    expect(result.metrics).toEqual({
      clients: 1,
      activeClients: 1,
      events: 2,
      upcoming: 1,
      drafts: 1,
      published: 1,
    });
  });

  it('marks other staff members’ events read-only while allowing changes to their own', async () => {
    const editableStaff: AuthenticatedActor = {
      ...actor,
      memberships: [{
        ...actor.memberships[0],
        permissions: [
          Permission.EVENT_READ,
          Permission.EVENT_EDIT,
          Permission.EVENT_DELETE,
          Permission.GUEST_MANAGE,
          Permission.INVITATION_SEND,
        ],
      }],
    };
    const startAt = new Date(Date.now() + 86_400_000);
    const events = [
      { id: 'own', clientId: 'client-a', createdByUserId: actor.userId, status: 'READY', startAt, endAt: null },
      { id: 'other', clientId: 'client-a', createdByUserId: 'staff-b', status: 'READY', startAt, endAt: null },
    ];
    const eventFindMany = vi.fn().mockResolvedValue(events);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      event: { findMany: eventFindMany },
      auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const lifecycle = new EventLifecycleService();
    const service = new DashboardService(
      prisma,
      { evaluate: vi.fn().mockReturnValue({ score: 100 }) } as unknown as EventCompletenessService,
      lifecycle,
      new EventMutationPolicyService(new AuthorizationService(), lifecycle),
    );

    const result = await service.get(editableStaff);

    expect(result.recentEvents[0]?.capabilities).toMatchObject({
      canEdit: true, canDelete: true, canCancel: true, canManageGuests: true, canSendInvitations: true,
    });
    expect(result.recentEvents[1]?.capabilities).toMatchObject({
      canEdit: false, canDelete: false, canCancel: false, canManageGuests: false, canSendInvitations: false,
    });
    expect(result.recentEvents[1]?.operationalStatus).toBe('UPCOMING');
    const query = eventFindMany.mock.calls[0]?.[0] as unknown as {
      include: { createdBy: unknown };
    };
    expect(query.include.createdBy).toBeDefined();
  });
});
