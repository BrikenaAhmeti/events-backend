import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { Permission } from '../../memberships/domain/permission';

type DashboardMetrics = {
  clients: number;
  activeClients: number;
  events: number;
  upcoming: number;
  drafts: number;
  published: number;
};

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
                (role === 'CLIENT_ADMIN' ||
                  permissions.includes(Permission.EVENT_READ)),
            )
            .map(({ clientId }) => clientId);
    const eventWhere = clientIds ? { clientId: { in: clientIds } } : {};
    const now = new Date();
    const [metricsRows, recentEvents, recentActivity] = await Promise.all([
      this.prisma.$queryRaw<DashboardMetrics[]>(
        this.metricsQuery(clientIds, now),
      ),
      this.prisma.event.findMany({
        where: eventWhere,
        take: 6,
        orderBy: { updatedAt: 'desc' },
        include: {
          client: { select: { id: true, name: true } },
          _count: {
            select: { guests: true, documents: true, invitations: true },
          },
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
    const metrics = metricsRows[0] ?? {
      clients: 0,
      activeClients: 0,
      events: 0,
      upcoming: 0,
      drafts: 0,
      published: 0,
    };
    return {
      metrics,
      recentEvents: recentEvents.map((event) => ({
        ...event,
        completeness: this.completeness.evaluate(event),
      })),
      recentActivity,
    };
  }

  private metricsQuery(clientIds: string[] | undefined, now: Date): Prisma.Sql {
    const clientScope =
      clientIds === undefined
        ? Prisma.sql`TRUE`
        : clientIds.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`c."id" IN (${Prisma.join(clientIds)})`;
    const eventScope =
      clientIds === undefined
        ? Prisma.sql`TRUE`
        : clientIds.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`e."clientId" IN (${Prisma.join(clientIds)})`;

    return Prisma.sql`
      WITH "clientMetrics" AS (
        SELECT
          COUNT(*)::integer AS "clients",
          (COUNT(*) FILTER (WHERE c."status" = 'ACTIVE'))::integer AS "activeClients"
        FROM "Client" AS c
        WHERE ${clientScope}
      ),
      "eventMetrics" AS (
        SELECT
          COUNT(*)::integer AS "events",
          (COUNT(*) FILTER (
            WHERE e."startAt" >= ${now} AND e."status" IN ('READY', 'PUBLISHED')
          ))::integer AS "upcoming",
          (COUNT(*) FILTER (WHERE e."status" = 'DRAFT'))::integer AS "drafts",
          (COUNT(*) FILTER (WHERE e."status" = 'PUBLISHED'))::integer AS "published"
        FROM "Event" AS e
        WHERE ${eventScope}
      )
      SELECT * FROM "clientMetrics" CROSS JOIN "eventMetrics"
    `;
  }
}
