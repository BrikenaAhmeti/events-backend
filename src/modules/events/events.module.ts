import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import {
  AddScheduleItemHandler,
  CancelEventHandler,
  CreateEventDraftHandler,
  DeleteEventHandler,
  GetEventHandler,
  GetEventsHandler,
  PublishEventHandler,
  UpdateEventDetailsHandler,
} from './application/event.handlers';
import { EventCompletenessService } from './domain/event-completeness.service';
import { EventsController } from './presentation/events.controller';
import { EventPublicationWorker } from './application/event-publication.worker';
import { EventLifecycleService } from './domain/event-lifecycle.service';
import { EventMutationPolicyService } from './domain/event-mutation-policy.service';
import { EventDirectoryService } from './application/event-directory.service';
import { GuestAccessModule } from '../guest-access/guest-access.module';

@Module({
  imports: [CqrsModule, GuestAccessModule],
  controllers: [EventsController],
  providers: [
    EventCompletenessService,
    EventLifecycleService,
    EventMutationPolicyService,
    EventDirectoryService,
    CreateEventDraftHandler,
    UpdateEventDetailsHandler,
    AddScheduleItemHandler,
    PublishEventHandler,
    CancelEventHandler,
    DeleteEventHandler,
    GetEventsHandler,
    GetEventHandler,
    EventPublicationWorker,
  ],
  exports: [
    EventCompletenessService,
    EventLifecycleService,
    EventMutationPolicyService,
    EventPublicationWorker,
  ],
})
export class EventsModule {}
