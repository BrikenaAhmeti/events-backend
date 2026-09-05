import { Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../common/types/request.types';
import { WebsocketTicketService } from './websocket-ticket.service';

@ApiTags('WebSocket')
@Controller('websocket')
export class WebsocketTicketController {
  constructor(private readonly tickets: WebsocketTicketService) {}

  @Post('ticket')
  issue(@CurrentActor() actor: AuthenticatedActor) {
    return this.tickets.issue(actor);
  }
}
