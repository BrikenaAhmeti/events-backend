import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { MAX_FUNCTION_UPLOAD_BYTES } from '../../../common/config/upload-limits';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PendingUploadService, uploadMetadataSchema } from '../../../infrastructure/storage/pending-upload.service';
import { guestSchema, importGuestsSchema, updateGuestSchema } from '../application/guest.contracts';
import { GuestImportService } from '../application/guest-import.service';
import { GuestsService } from '../application/guests.service';

@ApiTags('Guests')
@Controller('events/:eventId/guests')
export class GuestsController {
  constructor(
    private readonly guests: GuestsService,
    private readonly imports: GuestImportService,
    private readonly pendingUploads: PendingUploadService,
  ) {}

  @Post('imports/sign')
  async signImport(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.guests.assertImportAccess(actor, eventId);
    return this.pendingUploads.issue(actor, 'GUEST_IMPORT', eventId, uploadMetadataSchema.parse(body));
  }

  @Post('imports/preview-upload')
  async previewUploaded(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string, @Body() body: unknown) {
    await this.guests.assertImportAccess(actor, eventId);
    const { ticket } = z.object({ ticket: z.string().min(1) }).parse(body);
    const uploaded = await this.pendingUploads.consume(actor, 'GUEST_IMPORT', eventId, ticket);
    try { return await this.imports.preview(uploaded.file); }
    finally { await this.pendingUploads.remove(uploaded.key); }
  }

  @Get()
  list(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('eventId') eventId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.guests.list(actor, eventId, cursor);
  }

  @Post()
  add(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.guests.add(actor, requestId, eventId, guestSchema.parse(body));
  }

  @Patch(':guestId')
  update(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Param('guestId') guestId: string,
    @Body() body: unknown,
  ) {
    return this.guests.update(actor, requestId, eventId, guestId, updateGuestSchema.parse(body));
  }

  @Post('imports/preview')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FUNCTION_UPLOAD_BYTES, files: 1 } }))
  async preview(
    @CurrentActor() actor: AuthenticatedActor,
    @Param('eventId') eventId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.guests.assertImportAccess(actor, eventId);
    return this.imports.preview(file);
  }

  @Post('imports/confirm')
  confirm(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.guests.import(actor, requestId, eventId, importGuestsSchema.parse(body).rows);
  }
}
