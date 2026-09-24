import { Injectable } from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import type { Permission } from '../../memberships/domain/permission';
import { EventLifecycleService } from './event-lifecycle.service';

type ManagedEvent = {
  clientId: string;
  createdByUserId: string;
  status: EventStatus;
  startAt: Date | null;
  endAt: Date | null;
};

@Injectable()
export class EventMutationPolicyService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly lifecycle: EventLifecycleService,
  ) {}

  canMutate(actor: AuthenticatedActor, event: ManagedEvent, permission: Permission): boolean {
    if (!this.authorization.can(actor, event.clientId, permission)) return false;
    if (!this.lifecycle.isMutable(event)) return false;
    if (actor.platformRole === 'SUPER_ADMIN') return true;
    const membership = actor.memberships.find(
      (item) => item.clientId === event.clientId && item.status === 'ACTIVE',
    );
    return membership?.role === 'CLIENT_ADMIN' || event.createdByUserId === actor.userId;
  }

  assertMutable(actor: AuthenticatedActor, event: ManagedEvent, permission: Permission): void {
    this.authorization.assert(actor, event.clientId, permission);
    if (this.canMutate(actor, event, permission)) return;
    if (!this.lifecycle.isMutable(event)) {
      throw new ApplicationError(
        409,
        'EVENT_CHANGES_CLOSED',
        'Only upcoming events can be changed. Events that have started, been cancelled, or been archived are closed for changes.',
      );
    }
    throw new ApplicationError(
      403,
      'EVENT_OWNERSHIP_REQUIRED',
      'Staff can change only events they created.',
    );
  }
}
