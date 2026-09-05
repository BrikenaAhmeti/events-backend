import { Module } from '@nestjs/common';
import { CommunicationWorker } from './application/communication.worker';
import { InvitationsService } from './application/invitations.service';
import { QrCodeService } from './application/qr-code.service';
import { InvitationsController } from './presentation/invitations.controller';
import { GuestAccessModule } from '../guest-access/guest-access.module';

@Module({
  imports: [GuestAccessModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, QrCodeService, CommunicationWorker],
  exports: [CommunicationWorker],
})
export class InvitationsModule {}
