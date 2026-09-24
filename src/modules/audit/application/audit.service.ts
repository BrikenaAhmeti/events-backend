import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

export type AuditInput = {
  actorUserId?: string;
  clientId?: string;
  eventId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  requestId: string;
  metadata?: Prisma.InputJsonValue;
};

export const auditLogQuerySchema = z
  .object({
    clientId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    action: z.string().trim().min(1).max(120).optional(),
    eventId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to), {
    message: 'The start date and time must be before the end date and time.',
    path: ['from'],
  });

export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        clientId: input.clientId,
        eventId: input.eventId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        requestId: input.requestId,
        metadata: input.metadata ?? {},
      },
    });
  }

  async list(actor: AuthenticatedActor, input: AuditLogQueryInput) {
    const clientIds = this.clientScope(actor, input.clientId);
    const where: Prisma.AuditLogWhereInput = {
      ...(clientIds ? { clientId: { in: clientIds } } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.from || input.to
        ? {
            createdAt: {
              ...(input.from ? { gte: new Date(input.from) } : {}),
              ...(input.to ? { lte: new Date(input.to) } : {}),
            },
          }
        : {}),
    };
    const records = await this.prisma.auditLog.findMany({
      relationLoadStrategy: 'join',
      where,
      take: input.limit + 1,
      ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        requestId: true,
        metadata: true,
        createdAt: true,
        actor: {
          select: { id: true, firstName: true, lastName: true, email: true, platformRole: true },
        },
        client: { select: { id: true, name: true } },
        event: { select: { id: true, name: true } },
      },
    });
    const items = records.slice(0, input.limit).map((record) => ({
      ...record,
      actor: record.actor
        ? {
            ...record.actor,
            email: record.actor.platformRole === 'SUPER_ADMIN' ? null : record.actor.email,
          }
        : null,
    }));
    return {
      items,
      pageInfo: {
        hasNextPage: records.length > input.limit,
        endCursor: records.length > input.limit ? items.at(-1)?.id : null,
      },
    };
  }

  async clients(actor: AuthenticatedActor) {
    const clientIds = this.clientScope(actor);
    return this.prisma.client.findMany({
      where: clientIds ? { id: { in: clientIds } } : {},
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true },
    });
  }

  async actors(actor: AuthenticatedActor, clientId?: string) {
    const clientIds = this.clientScope(actor, clientId);
    const memberships = await this.prisma.clientMembership.findMany({
      where: {
        status: 'ACTIVE',
        user: { platformRole: null },
        ...(clientIds ? { clientId: { in: clientIds } } : {}),
      },
      take: 1_000,
      select: {
        role: true,
        user: {
          select: { id: true, firstName: true, lastName: true, platformRole: true },
        },
      },
    });
    return Array.from(
      new Map(memberships
        .filter(({ user }) => user.platformRole !== 'SUPER_ADMIN')
        .map(({ user, role }) => [user.id, {
          id: user.id, firstName: user.firstName, lastName: user.lastName, role,
        }])).values(),
    ).sort((left, right) =>
      `${left.firstName} ${left.lastName}`.localeCompare(`${right.firstName} ${right.lastName}`),
    );
  }

  async actions(actor: AuthenticatedActor, clientId?: string) {
    const clientIds = this.clientScope(actor, clientId);
    const actions = await this.prisma.auditLog.findMany({
      where: clientIds ? { clientId: { in: clientIds } } : {},
      distinct: ['action'],
      orderBy: { action: 'asc' },
      take: 500,
      select: { action: true },
    });
    return actions.map(({ action }) => action);
  }

  private clientScope(actor: AuthenticatedActor, requestedClientId?: string): string[] | undefined {
    if (actor.platformRole === 'SUPER_ADMIN') {
      return requestedClientId ? [requestedClientId] : undefined;
    }
    const administratorClientIds = actor.memberships
      .filter(({ role, status }) => role === 'CLIENT_ADMIN' && status === 'ACTIVE')
      .map(({ clientId }) => clientId);
    if (administratorClientIds.length === 0) {
      throw new ApplicationError(
        403,
        'AUDIT_ACCESS_REQUIRED',
        'Only administrators can view activity history.',
      );
    }
    if (requestedClientId && !administratorClientIds.includes(requestedClientId)) {
      throw new ApplicationError(403, 'FORBIDDEN', 'You cannot view activity for this client.');
    }
    return requestedClientId ? [requestedClientId] : administratorClientIds;
  }
}
