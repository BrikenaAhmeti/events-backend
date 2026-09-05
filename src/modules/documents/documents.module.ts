import { Module } from '@nestjs/common';
import { DocumentProcessingWorker } from './application/document-processing.worker';
import { DocumentsService } from './application/documents.service';
import { DocumentTextExtractorService } from './application/document-text-extractor.service';
import { FileValidationService } from './application/file-validation.service';
import { DocumentsController } from './presentation/documents.controller';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    FileValidationService,
    DocumentTextExtractorService,
    DocumentProcessingWorker,
  ],
  exports: [DocumentTextExtractorService, FileValidationService, DocumentProcessingWorker],
})
export class DocumentsModule {}
