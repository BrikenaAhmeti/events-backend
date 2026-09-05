import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestContext } from '../../../common/types/request.types';
import { GuestAccessService } from '../application/guest-access.service';
import { GuestSessionGuard } from './guest-session.guard';

@Public()
@ApiTags('Guest access')
@Controller()
export class GuestAccessController {
  constructor(private readonly access: GuestAccessService) {}

  @Get('public/events/:slug')
  publicEvent(@Param('slug') slug: string) {
    return this.access.publicEvent(slug);
  }

  @Post('public/events/:slug/access')
  identify(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.access.identify(slug, body, request.ip, response);
  }

  @Post('public/invitations/exchange')
  exchange(
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.access.exchange(body, request.ip, response);
  }

  @Post('public/invitations/preview')
  preview(@Body() body: unknown, @Req() request: RequestContext) {
    return this.access.invitationPreview(body, request.ip);
  }

  @UseGuards(GuestSessionGuard)
  @Get('guest/events/:eventId')
  guestEvent(@Param('eventId') eventId: string, @Req() request: RequestContext) {
    return this.access.guestEvent(eventId, request.guestActor?.guestId ?? '');
  }
}
