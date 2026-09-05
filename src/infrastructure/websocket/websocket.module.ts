import { Global, Module } from '@nestjs/common';
import { EventGateway } from './event.gateway';
import { WebsocketTicketController } from './websocket-ticket.controller';
import { WebsocketTicketService } from './websocket-ticket.service';

@Global()
@Module({
  controllers: [WebsocketTicketController],
  providers: [WebsocketTicketService, EventGateway],
  exports: [EventGateway, WebsocketTicketService],
})
export class WebsocketModule {}
