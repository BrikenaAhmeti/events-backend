import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { CreateClientInput, UpdateClientInput } from './client.contracts';

export class CreateClientCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly input: CreateClientInput,
  ) {}
}

export class UpdateClientCommand {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly requestId: string,
    readonly clientId: string,
    readonly input: UpdateClientInput,
  ) {}
}

export class GetClientsQuery {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly cursor?: string,
  ) {}
}

export class GetClientQuery {
  constructor(
    readonly actor: AuthenticatedActor,
    readonly clientId: string,
  ) {}
}
