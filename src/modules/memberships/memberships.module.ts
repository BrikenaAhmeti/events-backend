import { Global, Module } from '@nestjs/common';
import { AuthorizationService } from './application/authorization.service';
import { TeamService } from './application/team.service';
import { TeamController } from './presentation/team.controller';

@Global()
@Module({
  controllers: [TeamController],
  providers: [AuthorizationService, TeamService],
  exports: [AuthorizationService],
})
export class MembershipsModule {}
