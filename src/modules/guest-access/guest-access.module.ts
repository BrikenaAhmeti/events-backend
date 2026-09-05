import { Module } from '@nestjs/common';
import { GuestAccessService } from './application/guest-access.service';
import { GuestAccessController } from './presentation/guest-access.controller';
import { GuestSessionGuard } from './presentation/guest-session.guard';
import { GuestAccessWindowService } from './application/guest-access-window.service';

@Module({
  controllers: [GuestAccessController],
  providers: [GuestAccessService, GuestSessionGuard, GuestAccessWindowService],
  exports: [GuestSessionGuard, GuestAccessWindowService],
})
export class GuestAccessModule {}
