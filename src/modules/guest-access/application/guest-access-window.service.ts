import { Injectable } from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { ApplicationError } from '../../../common/errors/application.error';

export type GuestAccessState = 'ACTIVE' | 'ENDED' | 'CANCELLED' | 'UNAVAILABLE';

type AccessEvent = {
  status: EventStatus;
  startAt: Date | null;
  endAt: Date | null;
};

@Injectable()
export class GuestAccessWindowService {
  readonly gracePeriodMs = 4 * 60 * 60 * 1000;

  state(event: AccessEvent, now = new Date()): GuestAccessState {
    if (event.status === 'CANCELLED') return 'CANCELLED';
    if (event.status !== 'PUBLISHED' || !event.startAt || !event.endAt) return 'UNAVAILABLE';
    if (now >= this.closesAt(event)) return 'ENDED';
    return 'ACTIVE';
  }

  closesAt(event: Pick<AccessEvent, 'endAt'>): Date {
    if (!event.endAt) return new Date(0);
    return new Date(event.endAt.getTime() + this.gracePeriodMs);
  }

  assertActive(event: AccessEvent, now = new Date()): void {
    const state = this.state(event, now);
    if (state === 'ACTIVE') return;
    const messages: Record<Exclude<GuestAccessState, 'ACTIVE'>, string> = {
      ENDED: 'This event has ended and guest access is now closed.',
      CANCELLED: 'This event has been cancelled.',
      UNAVAILABLE: 'This event is not available for guest access.',
    };
    throw new ApplicationError(410, `EVENT_${state}`, messages[state]);
  }
}
