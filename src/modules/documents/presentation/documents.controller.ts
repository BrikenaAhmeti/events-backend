import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { MAX_FUNCTION_UPLOAD_BYTES } from '../../../common/config/upload-limits';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PendingUploadService, uploadMetadataSchema } from '../../../infrastructure/storage/pending-upload.service';
import { DocumentsService } from '../application/documents.service';

@ApiTags('Documents')
@Controller('events/:eventId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService, private readonly pendingUploads: PendingUploadService) {}

  @Post('uploads/sign')
  async signUpload(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.documents.assertUploadAccess(actor, eventId);
    return this.pendingUploads.issue(actor, 'DOCUMENT', eventId, uploadMetadataSchema.parse(body));
  }

  @Post('uploads/complete')
  async completeUpload(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const { ticket } = z.object({ ticket: z.string().min(1) }).parse(body);
    const uploaded = await this.pendingUploads.consume(actor, 'DOCUMENT', eventId, ticket);
    try { return await this.documents.upload(actor, requestId, eventId, uploaded.file); }
    finally { await this.pendingUploads.remove(uploaded.key); }
  }

  @Get()
  list(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    return this.documents.list(actor, eventId);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: MAX_FUNCTION_UPLOAD_BYTES } }))
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
