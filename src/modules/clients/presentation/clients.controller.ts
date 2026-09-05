import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ApiTags } from '@nestjs/swagger';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import {
  CreateClientCommand,
  GetClientQuery,
  GetClientsQuery,
  UpdateClientCommand,
} from '../application/client.commands';
import { createClientSchema, updateClientSchema } from '../application/client.contracts';

@ApiTags('Clients')
@Controller('clients')
export class ClientsController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Query('cursor') cursor?: string) {
    return this.queries.execute(new GetClientsQuery(actor, cursor));
  }

  @Get(':clientId')
  get(@CurrentActor() actor: AuthenticatedActor, @Param('clientId') clientId: string) {
    return this.queries.execute(new GetClientQuery(actor, clientId));
  }

  @Post()
  create(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Body() body: unknown,
  ) {
    return this.commands.execute(
      new CreateClientCommand(actor, requestId, createClientSchema.parse(body)),
    );
  }

  @Patch(':clientId')
  update(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
  ) {
    return this.commands.execute(
      new UpdateClientCommand(actor, requestId, clientId, updateClientSchema.parse(body)),
    );
  }
}
