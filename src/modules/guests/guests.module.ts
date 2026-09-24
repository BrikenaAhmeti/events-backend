import { Module } from '@nestjs/common';
import { GuestImportService } from './application/guest-import.service';
import { GuestsService } from './application/guests.service';
import { GuestsController } from './presentation/guests.controller';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule],
  controllers: [GuestsController],
  providers: [GuestImportService, GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
