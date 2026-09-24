import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
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
    @Body() body: unknown,
  ) {
    const input = z.object({ guestIds: z.array(z.uuid()).min(1).max(5_000).optional() }).parse(body ?? {});
    return this.invitations.send(actor, requestId, eventId, input.guestIds);
  }

  @Post('guests/:guestId/resend')
  resendGuest(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Param('guestId') guestId: string,
  ) {
    return this.invitations.resendGuest(actor, requestId, eventId, guestId);
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
