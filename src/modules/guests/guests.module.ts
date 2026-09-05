import { Module } from '@nestjs/common';
import { GuestImportService } from './application/guest-import.service';
import { GuestsService } from './application/guests.service';
import { GuestsController } from './presentation/guests.controller';

@Module({
  controllers: [GuestsController],
  providers: [GuestImportService, GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
