import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { GuestAccessModule } from '../guest-access/guest-access.module';
import { ConciergeService } from './application/concierge.service';
import { OrganizerExtractionService } from './application/organizer-extraction.service';
import { ConciergeController } from './presentation/concierge.controller';
import { DocumentsModule } from '../documents/documents.module';
import { EventsModule } from '../events/events.module';
import { EventSetupAnalysisService } from './application/event-setup-analysis.service';

@Module({
  imports: [CqrsModule, KnowledgeModule, GuestAccessModule, DocumentsModule, EventsModule],
  controllers: [ConciergeController],
  providers: [ConciergeService, OrganizerExtractionService, EventSetupAnalysisService],
})
export class ConciergeModule {}
