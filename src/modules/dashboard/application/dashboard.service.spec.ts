import type { Prisma } from '@prisma/client';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { EventCompletenessService } from '../../events/domain/event-completeness.service';
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
    } as unknown as EventCompletenessService);

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
});
