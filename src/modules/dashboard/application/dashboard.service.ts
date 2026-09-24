import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { EventLifecycleService } from '../../events/domain/event-lifecycle.service';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
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
    private readonly lifecycle: EventLifecycleService,
    private readonly policy: EventMutationPolicyService,
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
        relationLoadStrategy: 'join',
        where: eventWhere,
        take: 6,
        orderBy: { updatedAt: 'desc' },
        include: {
          client: { select: { id: true, name: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
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
        operationalStatus: this.lifecycle.status(event, now),
        capabilities: {
          canEdit: this.policy.canMutate(actor, event, Permission.EVENT_EDIT),
          canManageGuests: this.policy.canMutate(actor, event, Permission.GUEST_MANAGE),
          canImportGuests: this.policy.canMutate(actor, event, Permission.GUEST_IMPORT),
          canSendInvitations: this.policy.canMutate(actor, event, Permission.INVITATION_SEND),
          canRevokeInvitations: this.policy.canMutate(actor, event, Permission.INVITATION_REVOKE),
          canPublish: this.policy.canMutate(actor, event, Permission.EVENT_PUBLISH),
          canUploadDocuments: this.policy.canMutate(actor, event, Permission.DOCUMENT_UPLOAD),
          canDelete: this.policy.canMutate(actor, event, Permission.EVENT_DELETE),
          canCancel: this.policy.canMutate(actor, event, Permission.EVENT_DELETE),
        },
      })),
      recentActivity,
    };
  }

  private metricsQuery(clientIds: string[] | undefined, now: Date): Prisma.Sql {
    // Raw-query string parameters are text; tenant IDs are UUID columns.
    const scopedIds = (clientIds ?? []).map((id) => Prisma.sql`${id}::uuid`);
    const clientScope =
      clientIds === undefined
        ? Prisma.sql`TRUE`
        : clientIds.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`c."id" IN (${Prisma.join(scopedIds)})`;
    const eventScope =
      clientIds === undefined
        ? Prisma.sql`TRUE`
        : clientIds.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`e."clientId" IN (${Prisma.join(scopedIds)})`;

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
