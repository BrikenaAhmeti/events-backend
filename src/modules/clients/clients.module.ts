import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import {
  CreateClientHandler,
  GetClientHandler,
  GetClientsHandler,
  UpdateClientHandler,
} from './application/client.handlers';
import { ClientsController } from './presentation/clients.controller';

@Module({
  imports: [CqrsModule],
  controllers: [ClientsController],
  providers: [CreateClientHandler, UpdateClientHandler, GetClientsHandler, GetClientHandler],
})
export class ClientsModule {}
