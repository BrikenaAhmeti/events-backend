import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import { ApplicationError } from '../../../common/errors/application.error';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SupabaseAuthProvider } from '../../auth/infrastructure/supabase-auth.provider';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import {
  CreateClientCommand,
  GetClientQuery,
  GetClientsQuery,
  UpdateClientCommand,
} from './client.commands';

const slugify = (value: string) =>
  `${value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 8)}`;

@CommandHandler(CreateClientCommand)
export class CreateClientHandler implements ICommandHandler<CreateClientCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: SupabaseAuthProvider,
  ) {}

  async execute({ actor, input, requestId }: CreateClientCommand) {
    if (actor.platformRole !== 'SUPER_ADMIN')
      throw new ApplicationError(
        403,
        'FORBIDDEN',
        'Only platform administrators can create clients.',
      );
    const supabaseUserId = input.admin
      ? await this.auth.provisionUser(input.admin.email, {
          firstName: input.admin.firstName,
          lastName: input.admin.lastName,
        })
      : null;
    const result = await this.prisma.$transaction(async (transaction) => {
      const client = await transaction.client.create({
        data: { name: input.name, slug: slugify(input.name), contactEmail: input.contactEmail },
      });
      if (input.admin && supabaseUserId) {
        const user = await transaction.user.create({
          data: {
            supabaseUserId,
            email: input.admin.email,
            firstName: input.admin.firstName,
            lastName: input.admin.lastName,
          },
        });
        const membership = await transaction.clientMembership.create({
          data: {
            userId: user.id,
            clientId: client.id,
            role: 'CLIENT_ADMIN',
            status: 'INVITED',
            invitedAt: new Date(),
          },
        });
        await transaction.backgroundJob.upsert({
          where: { idempotencyKey: `client-admin:${client.id}:${input.admin.email}` },
          create: {
            type: 'STAFF_INVITATION_EMAIL',
            idempotencyKey: `client-admin:${client.id}:${input.admin.email}`,
            clientId: client.id,
            payload: { membershipId: membership.id },
          },
          update: {},
        });
      }
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: client.id,
          action: 'CLIENT_CREATED',
          entityType: 'Client',
          entityId: client.id,
          requestId,
        },
      });
      return client;
    });
    return result;
  }
}

@CommandHandler(UpdateClientCommand)
export class UpdateClientHandler implements ICommandHandler<UpdateClientCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async execute({ actor, clientId, input, requestId }: UpdateClientCommand) {
    this.authorization.assert(actor, clientId, Permission.CLIENT_SETTINGS_MANAGE);
    if (input.status && actor.platformRole !== 'SUPER_ADMIN')
      throw new ApplicationError(
        403,
        'CLIENT_STATUS_RESTRICTED',
        'Only platform administrators can change client status.',
      );
    return this.prisma.$transaction(async (transaction) => {
      const client = await transaction.client.update({ where: { id: clientId }, data: input });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId,
          action: 'CLIENT_UPDATED',
          entityType: 'Client',
          entityId: clientId,
          requestId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return client;
    });
  }
}

@QueryHandler(GetClientsQuery)
export class GetClientsHandler implements IQueryHandler<GetClientsQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute({ actor, cursor }: GetClientsQuery) {
    const clientIds =
      actor.platformRole === 'SUPER_ADMIN'
        ? undefined
        : actor.memberships
            .filter(({ status }) => status === 'ACTIVE')
            .map(({ clientId }) => clientId);
    const records = await this.prisma.client.findMany({
      where: clientIds ? { id: { in: clientIds } } : {},
      take: 21,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      include: {
        _count: {
          select: {
            events: true,
            memberships: { where: { role: 'CLIENT_STAFF' } },
          },
        },
      },
    });
    const hasNextPage = records.length > 20;
    const items = records.slice(0, 20);
    return { items, pageInfo: { hasNextPage, endCursor: hasNextPage ? items.at(-1)?.id : null } };
  }
}

@QueryHandler(GetClientQuery)
export class GetClientHandler implements IQueryHandler<GetClientQuery> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async execute({ actor, clientId }: GetClientQuery) {
    this.authorization.assert(actor, clientId, Permission.CLIENT_SETTINGS_MANAGE);
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: {
        memberships: {
          include: {
            user: { select: { id: true, email: true, firstName: true, lastName: true } },
            permissions: true,
          },
        },
        events: {
          take: 10,
          orderBy: { startAt: 'asc' },
          include: { _count: { select: { guests: true } } },
        },
      },
    });
    if (!client) throw new ApplicationError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
    return client;
  }
}
