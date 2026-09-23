import { Injectable } from '@nestjs/common';
import type { EventStatus } from '@prisma/client';

export type OperationalEventStatus = 'UNSCHEDULED' | 'UPCOMING' | 'ONGOING' | 'PAST' | 'CANCELLED';

type LifecycleEvent = {
  status: EventStatus;
  startAt: Date | null;
  endAt: Date | null;
};

@Injectable()
export class EventLifecycleService {
  status(event: LifecycleEvent, now = new Date()): OperationalEventStatus {
    if (event.status === 'CANCELLED') return 'CANCELLED';
    if (!event.startAt) return 'UNSCHEDULED';
    if (event.startAt > now) return 'UPCOMING';
    if (!event.endAt || event.endAt >= now) return 'ONGOING';
    return 'PAST';
  }

  isMutable(event: LifecycleEvent, now = new Date()): boolean {
    return !['CANCELLED', 'ARCHIVED'].includes(event.status) && this.status(event, now) !== 'PAST';
  }

  isAdministrativelyMutable(event: LifecycleEvent): boolean {
    return !['CANCELLED', 'ARCHIVED'].includes(event.status);
  }
}
