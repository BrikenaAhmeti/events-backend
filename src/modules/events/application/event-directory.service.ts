import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';

@Injectable()
export class EventDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async clients(actor: AuthenticatedActor) {
    if (actor.platformRole !== 'SUPER_ADMIN') {
      throw new ApplicationError(
        403,
        'FORBIDDEN',
        'Only platform administrators can view the client directory.',
      );
    }
    return this.prisma.client.findMany({
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true, slug: true, status: true },
    });
  }

  async creators(actor: AuthenticatedActor, clientId?: string) {
    const resolvedClientId =
      clientId ?? (actor.platformRole === 'SUPER_ADMIN'
        ? undefined
        : actor.memberships.find(({ status }) => status === 'ACTIVE')?.clientId);
    if (!resolvedClientId && actor.platformRole !== 'SUPER_ADMIN') {
      throw new ApplicationError(400, 'CLIENT_CONTEXT_REQUIRED', 'Select a client to continue.');
    }
    if (resolvedClientId) this.authorization.assert(actor, resolvedClientId, Permission.EVENT_READ);
    return this.prisma.user.findMany({
      where: { createdEvents: { some: resolvedClientId ? { clientId: resolvedClientId } : {} } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 200,
      select: { id: true, firstName: true, lastName: true, email: true },
    });
  }
}
