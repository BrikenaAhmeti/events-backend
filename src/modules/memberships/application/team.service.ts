import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SupabaseAuthProvider } from '../../auth/infrastructure/supabase-auth.provider';
import {
  Permission as PermissionValues,
  operationalPermissions,
  type Permission,
} from '../domain/permission';
import { AuthorizationService } from './authorization.service';

const permissionValues = Object.values(PermissionValues) as [Permission, ...Permission[]];

export const inviteStaffSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  permissions: z.array(z.enum(permissionValues)).default(operationalPermissions),
});

export const updateStaffSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  permissions: z.array(z.enum(permissionValues)).optional(),
});

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auth: SupabaseAuthProvider,
  ) {}

  async list(actor: AuthenticatedActor, clientId: string) {
    this.authorization.assert(actor, clientId, PermissionValues.TEAM_READ);
    return this.prisma.clientMembership.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        role: true,
        status: true,
        invitedAt: true,
        joinedAt: true,
        createdAt: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        permissions: { select: { permission: true } },
      },
    });
  }

  async invite(actor: AuthenticatedActor, requestId: string, clientId: string, raw: unknown) {
    this.authorization.assert(actor, clientId, PermissionValues.TEAM_MANAGE);
    const input = inviteStaffSchema.parse(raw);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    const supabaseUserId = existing
      ? existing.supabaseUserId
      : await this.auth.provisionUser(input.email, {
          firstName: input.firstName,
          lastName: input.lastName,
        });
    const membership = await this.prisma.$transaction(async (transaction) => {
      const user =
        existing ??
        (await transaction.user.create({
          data: {
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            supabaseUserId,
          },
        }));
      const created = await transaction.clientMembership.upsert({
        where: { userId_clientId: { userId: user.id, clientId } },
        create: {
          userId: user.id,
          clientId,
          role: 'CLIENT_STAFF',
          status: 'INVITED',
          invitedAt: new Date(),
          permissions: { create: input.permissions.map((permission) => ({ permission })) },
        },
        update: {
          status: 'INVITED',
          invitedAt: new Date(),
          permissions: {
            deleteMany: {},
            create: input.permissions.map((permission) => ({ permission })),
          },
        },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId,
          action: 'CLIENT_STAFF_INVITED',
          entityType: 'ClientMembership',
          entityId: created.id,
          requestId,
        },
      });
      await transaction.backgroundJob.upsert({
        where: { idempotencyKey: `staff:${created.id}:${created.invitedAt?.getTime()}` },
        create: {
          type: 'STAFF_INVITATION_EMAIL',
          idempotencyKey: `staff:${created.id}:${created.invitedAt?.getTime()}`,
          clientId,
          payload: { membershipId: created.id },
        },
        update: {},
      });
      return created;
    });
    return membership;
  }

  async update(
    actor: AuthenticatedActor,
    requestId: string,
    clientId: string,
    membershipId: string,
    raw: unknown,
  ) {
    this.authorization.assert(actor, clientId, PermissionValues.TEAM_MANAGE);
    const input = updateStaffSchema.parse(raw);
    const membership = await this.prisma.clientMembership.findFirst({
      where: { id: membershipId, clientId },
    });
    if (!membership)
      throw new ApplicationError(404, 'MEMBERSHIP_NOT_FOUND', 'Team member not found.');
    if (membership.role === 'CLIENT_ADMIN' && input.status === 'DISABLED')
      throw new ApplicationError(
        400,
        'ADMIN_DISABLE_RESTRICTED',
        'Transfer administration before disabling this administrator.',
      );
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.clientMembership.update({
        where: { id: membershipId },
        data: {
          status: input.status,
          ...(input.permissions
            ? {
                permissions: {
                  deleteMany: {},
                  create: input.permissions.map((permission) => ({ permission })),
                },
              }
            : {}),
        },
        include: {
          permissions: true,
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId,
          action: input.status === 'DISABLED' ? 'CLIENT_STAFF_DISABLED' : 'CLIENT_STAFF_UPDATED',
          entityType: 'ClientMembership',
          entityId: membershipId,
          requestId,
          metadata: { permissionsChanged: Boolean(input.permissions) },
        },
      });
      return updated;
    });
  }
}
