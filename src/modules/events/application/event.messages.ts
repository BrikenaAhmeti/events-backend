import type { AuthenticatedActor } from '../../../common/types/request.types';
import type {
  CreateEventInput,
  EventListQueryInput,
  ScheduleItemInput,
  UpdateEventInput,
} from './event.contracts';

export class CreateEventDraftCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly input: CreateEventInput,
  ) {}
}

export class UpdateEventDetailsCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly eventId: string,
    readonly input: UpdateEventInput,
  ) {}
}

export class AddScheduleItemCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly eventId: string,
    readonly input: ScheduleItemInput,
  ) {}
}

export class PublishEventCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly eventId: string,
    readonly sendInvitations = true,
  ) {}
}

export class CancelEventCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly eventId: string,
  ) {}
}

export class DeleteEventCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly eventId: string,
  ) {}
}

export class GetEventsQuery {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly input: EventListQueryInput,
  ) {}
}

export class GetEventQuery {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly eventId: string,
  ) {}
}
