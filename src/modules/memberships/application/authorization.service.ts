import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { Permission } from '../domain/permission';

@Injectable()
export class AuthorizationService {
  can(actor: AuthenticatedActor, clientId: string, permission: Permission): boolean {
    if (actor.platformRole === 'SUPER_ADMIN') return true;
    const membership = actor.memberships.find(
      (candidate) => candidate.clientId === clientId && candidate.status === 'ACTIVE',
    );
    if (!membership) return false;
    if (membership.role === 'CLIENT_ADMIN') return true;
    return membership.permissions.includes(permission);
  }

  assert(actor: AuthenticatedActor, clientId: string, permission: Permission): void {
    if (!this.can(actor, clientId, permission)) {
      throw new ApplicationError(
        403,
        'FORBIDDEN',
        'You do not have permission to perform this action.',
      );
    }
  }
}
