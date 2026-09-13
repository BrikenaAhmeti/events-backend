import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CurrentActor, CurrentRequestId } from '../../../common/decorators/current-actor.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { ApplicationError } from '../../../common/errors/application.error';
import { RateLimitService } from '../../../common/security/rate-limit.service';
import type { AuthenticatedActor, RequestContext } from '../../../common/types/request.types';
import { GuestSessionGuard } from '../../guest-access/presentation/guest-session.guard';
import { ConciergeService, type ConciergeStreamEvent } from '../application/concierge.service';
import { OrganizerExtractionService } from '../application/organizer-extraction.service';
import { EventSetupAnalysisService } from '../application/event-setup-analysis.service';

const questionSchema = z.object({ message: z.string().trim().min(1).max(4_000) });
const sourceSchema = z.object({ text: z.string().trim().min(10).max(80_000) });

@ApiTags('Concierge')
@Controller()
export class ConciergeController {
  constructor(
    private readonly concierge: ConciergeService,
    private readonly extraction: OrganizerExtractionService,
    private readonly rateLimits: RateLimitService,
    private readonly setupAnalysis: EventSetupAnalysisService,
  ) {}

  @Post('events/setup/start')
  startSetup(@CurrentActor() actor: AuthenticatedActor, @Body() body: unknown) {
    this.rateLimits.assert(`concierge:setup-start:${actor.userId}`, 20, 60_000);
    return this.setupAnalysis.start(actor, body);
  }

  @Post('events/setup/analyze')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: 20 * 1024 * 1024 } }))
  analyzeSetup(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Body() body: unknown,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    this.rateLimits.assert(`concierge:setup:${actor.userId}`, 10, 60_000);
    return this.setupAnalysis.analyze(actor, body, file, requestId);
  }

  @Post('events/:eventId/concierge/messages')
  askPlatform(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    this.rateLimits.assert(`concierge:platform:${actor.userId}:${eventId}`, 60, 60_000);
    return this.concierge.askPlatform(
      actor,
      eventId,
      questionSchema.parse(body).message,
      requestId,
    );
  }

  @Get('events/:eventId/concierge/messages')
  historyPlatform(@CurrentActor() actor: AuthenticatedActor, @Param('eventId') eventId: string) {
    return this.concierge.historyPlatform(actor, eventId);
  }

  @Post('events/:eventId/concierge/stream')
  streamPlatform(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    this.rateLimits.assert(`concierge:platform:${actor.userId}:${eventId}`, 60, 60_000);
    const input = questionSchema.parse(body);
    return this.stream(response, (onEvent) =>
      this.concierge.askPlatform(actor, eventId, input.message, requestId, onEvent),
    );
  }

  @Post('events/:eventId/concierge/extract')
  extract(
    @CurrentActor() actor: AuthenticatedActor,
    @CurrentRequestId() requestId: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    this.rateLimits.assert(`concierge:extract:${actor.userId}:${eventId}`, 10, 60_000);
    return this.extraction.extractAndApply(
      actor,
      eventId,
      sourceSchema.parse(body).text,
      requestId,
    );
  }

  @Public()
  @UseGuards(GuestSessionGuard)
  @Post('guest/events/:eventId/concierge/messages')
  askGuest(
    @Req() request: RequestContext,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const actor = request.guestActor;
    if (!actor || actor.eventId !== eventId)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    this.rateLimits.assert(`concierge:guest:${actor.sessionId}:${eventId}`, 30, 60_000);
    return this.concierge.askGuest(actor, questionSchema.parse(body).message, request.requestId);
  }

  @Public()
  @UseGuards(GuestSessionGuard)
  @Get('guest/events/:eventId/concierge/messages')
  historyGuest(@Req() request: RequestContext, @Param('eventId') eventId: string) {
    const actor = request.guestActor;
    if (!actor || actor.eventId !== eventId)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    return this.concierge.historyGuest(actor);
  }

  @Public()
  @UseGuards(GuestSessionGuard)
  @Post('guest/events/:eventId/concierge/stream')
  streamGuest(
    @Req() request: RequestContext,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const actor = request.guestActor;
    if (!actor || actor.eventId !== eventId)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    this.rateLimits.assert(`concierge:guest:${actor.sessionId}:${eventId}`, 30, 60_000);
    const input = questionSchema.parse(body);
    return this.stream(response, (onEvent) =>
      this.concierge.askGuest(actor, input.message, request.requestId, onEvent),
    );
  }

  private async stream(
    response: Response,
    operation: (onEvent: (event: ConciergeStreamEvent) => void) => Promise<unknown>,
  ): Promise<void> {
    response.status(200);
    response.set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let errorSent = false;
    const onEvent = (event: ConciergeStreamEvent) => {
      if (event.type === 'error') errorSent = true;
      response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      await operation(onEvent);
    } catch (error) {
      if (!errorSent) {
        onEvent({
          type: 'error',
          messageId: randomUUID(),
          message:
            error instanceof ApplicationError
              ? error.message
              : 'Concierge is temporarily unavailable. Please try again shortly.',
        });
      }
    } finally {
      response.end();
    }
  }
}
