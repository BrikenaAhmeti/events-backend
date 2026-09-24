import { Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAX_UPLOAD_BYTES } from '../../../common/config/upload-limits';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { DocumentsService } from '../application/documents.service';

@ApiTags('Documents')
@Controller('events/:eventId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    return this.documents.list(actor, eventId);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.documents.upload(actor, requestId, eventId, file);
  }

  @Get(':documentId/download')
  download(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('eventId') eventId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.documents.downloadUrl(actor, eventId, documentId);
  }
}
