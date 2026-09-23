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
    if (actor.platformRole === 'SUPER_ADMIN')
      return this.lifecycle.isAdministrativelyMutable(event);
    const membership = actor.memberships.find(
      (item) => item.clientId === event.clientId && item.status === 'ACTIVE',
    );
    if (membership?.role === 'CLIENT_ADMIN') return this.lifecycle.isAdministrativelyMutable(event);
    return event.createdByUserId === actor.userId && this.lifecycle.isMutable(event);
  }

  assertMutable(actor: AuthenticatedActor, event: ManagedEvent, permission: Permission): void {
    this.authorization.assert(actor, event.clientId, permission);
    if (this.canMutate(actor, event, permission)) return;
    if (!this.lifecycle.isAdministrativelyMutable(event)) {
      throw new ApplicationError(
        409,
        'EVENT_CHANGES_CLOSED',
        'Cancelled and archived events cannot be changed.',
      );
    }
    if (!this.lifecycle.isMutable(event)) {
      throw new ApplicationError(
        409,
        'EVENT_CHANGES_CLOSED',
        'Staff can change only unscheduled, upcoming, or ongoing events.',
      );
    }
    throw new ApplicationError(
      403,
      'EVENT_OWNERSHIP_REQUIRED',
      'Staff can change only events they created.',
    );
  }
}
