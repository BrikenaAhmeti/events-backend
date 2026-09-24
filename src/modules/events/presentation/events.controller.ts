import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import {
  createEventSchema,
  eventListQuerySchema,
  scheduleItemSchema,
  updateEventDetailsSchema,
} from '../application/event.contracts';
import {
  AddScheduleItemCommand,
  CancelEventCommand,
  CreateEventDraftCommand,
  DeleteEventCommand,
  GetEventQuery,
  GetEventsQuery,
  PublishEventCommand,
  UpdateEventDetailsCommand,
} from '../application/event.messages';
import { EventDirectoryService } from '../application/event-directory.service';

@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
    private readonly directory: EventDirectoryService,
  ) {}

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Query() query: unknown) {
    return this.queries.execute(new GetEventsQuery(actor, eventListQuerySchema.parse(query)));
  }

  @Get('directory/creators')
  creators(@CurrentActor() actor: AuthenticatedActor, @Query('clientId') clientId?: string) {
    return this.directory.creators(actor, clientId);
  }

  @Get('directory/clients')
  clients(@CurrentActor() actor: AuthenticatedActor) {
    return this.directory.clients(actor);
  }

  @Get(':eventId')
  get(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    return this.queries.execute(new GetEventQuery(actor, eventId));
  }

  @Post()
  create(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Body() body: unknown,
  ) {
    return this.commands.execute(
      new CreateEventDraftCommand(actor, requestId, createEventSchema.parse(body)),
    );
  }

  @Patch(':eventId')
  update(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.commands.execute(
      new UpdateEventDetailsCommand(actor, requestId, eventId, updateEventDetailsSchema.parse(body)),
    );
  }

  @Post(':eventId/schedule')
  addSchedule(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.commands.execute(
      new AddScheduleItemCommand(actor, requestId, eventId, scheduleItemSchema.parse(body)),
    );
  }

  @Post(':eventId/publish')
  publish(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ sendInvitations: z.boolean().optional() }).parse(body ?? {});
    return this.commands.execute(new PublishEventCommand(actor, requestId, eventId, input.sendInvitations ?? true));
  }

  @Post(':eventId/cancel')
  cancel(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.commands.execute(new CancelEventCommand(actor, requestId, eventId));
  }

  @Delete(':eventId')
  @HttpCode(204)
  remove(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.commands.execute(new DeleteEventCommand(actor, requestId, eventId));
  }

  @Get(':eventId/completeness')
  async completeness(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    const event = await this.queries.execute<GetEventQuery, { completeness: unknown }>(
      new GetEventQuery(actor, eventId),
    );
    return event.completeness;
  }
}
