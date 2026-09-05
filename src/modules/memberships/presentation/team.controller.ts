import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { TeamService } from '../application/team.service';

@ApiTags('Team')
@Controller('clients/:clientId/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Param('clientId') clientId: string) {
    return this.team.list(actor, clientId);
  }

  @Post('invitations')
  invite(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('clientId') clientId: string,
    @Body() body: unknown,
  ) {
    return this.team.invite(actor, requestId, clientId, body);
  }

  @Patch(':membershipId')
  update(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('clientId') clientId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ) {
    return this.team.update(actor, requestId, clientId, membershipId, body);
  }
}
