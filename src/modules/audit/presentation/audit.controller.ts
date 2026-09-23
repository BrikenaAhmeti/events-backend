import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { AuditService, auditLogQuerySchema } from '../application/audit.service';

@ApiTags('Activity')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Query() query: unknown) {
    return this.audit.list(actor, auditLogQuerySchema.parse(query));
  }

  @Get('directory/clients')
  clients(@CurrentActor() actor: AuthenticatedActor) {
    return this.audit.clients(actor);
  }

  @Get('directory/actors')
  actors(@CurrentActor() actor: AuthenticatedActor, @Query('clientId') clientId?: string) {
    return this.audit.actors(actor, clientId);
  }

  @Get('directory/actions')
  actions(@CurrentActor() actor: AuthenticatedActor, @Query('clientId') clientId?: string) {
    return this.audit.actions(actor, clientId);
  }
}
