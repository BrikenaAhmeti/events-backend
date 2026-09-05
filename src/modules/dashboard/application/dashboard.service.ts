import { Injectable } from '@nestjs/common';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { Permission } from '../../memberships/domain/permission';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly completeness: EventCompletenessService,
  ) {}

  async get(actor: AuthenticatedActor) {
    const clientIds =
      actor.platformRole === 'SUPER_ADMIN'
        ? undefined
        : actor.memberships
            .filter(
              ({ status, role, permissions }) =>
                status === 'ACTIVE' &&
                (role === 'CLIENT_ADMIN' || permissions.includes(Permission.EVENT_READ)),
            )
            .map(({ clientId }) => clientId);
    const eventWhere = clientIds ? { clientId: { in: clientIds } } : {};
    const clientWhere = clientIds ? { id: { in: clientIds } } : {};
    const now = new Date();
    const [
      clients,
      activeClients,
      events,
      upcoming,
      drafts,
      published,
      recentEvents,
      recentActivity,
    ] = await Promise.all([
      this.prisma.client.count({ where: clientWhere }),
      this.prisma.client.count({ where: { ...clientWhere, status: 'ACTIVE' } }),
      this.prisma.event.count({ where: eventWhere }),
      this.prisma.event.count({
        where: { ...eventWhere, startAt: { gte: now }, status: { in: ['READY', 'PUBLISHED'] } },
      }),
      this.prisma.event.count({ where: { ...eventWhere, status: 'DRAFT' } }),
      this.prisma.event.count({ where: { ...eventWhere, status: 'PUBLISHED' } }),
      this.prisma.event.findMany({
        where: eventWhere,
        take: 6,
        orderBy: { updatedAt: 'desc' },
        include: {
          client: { select: { id: true, name: true } },
          _count: { select: { guests: true, documents: true, invitations: true } },
        },
      }),
      this.prisma.auditLog.findMany({
        where: clientIds ? { clientId: { in: clientIds } } : {},
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          action: true,
          entityType: true,
          clientId: true,
          eventId: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      metrics: { clients, activeClients, events, upcoming, drafts, published },
      recentEvents: recentEvents.map((event) => ({
        ...event,
        completeness: this.completeness.evaluate(event),
      })),
      recentActivity,
    };
  }
}
