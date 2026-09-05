import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { InvitationsService } from '../application/invitations.service';

@ApiTags('Invitations')
@Controller('events/:eventId/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    return this.invitations.list(actor, eventId);
  }

  @Get('general-access')
  general(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    return this.invitations.generalAccess(actor, eventId);
  }

  @Post('send')
  send(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.invitations.send(actor, requestId, eventId);
  }

  @Post(':invitationId/revoke')
  revoke(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitations.revoke(actor, requestId, eventId, invitationId);
  }
}
