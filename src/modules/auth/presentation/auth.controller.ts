import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { AuthenticatedActor, RequestContext } from '../../../common/types/request.types';
import { PLATFORM_REFRESH_COOKIE } from '../../../common/security/cookie.constants';
import { RateLimitService } from '../../../common/security/rate-limit.service';
import { AuthService } from '../application/auth.service';

const loginSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(200),
});
const emailSchema = z.object({ email: z.email().transform((value) => value.toLowerCase()) });
const activationSchema = z.object({
  tokenHash: z.string().min(20).max(500),
  password: z.string().min(12).max(200),
});
const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Get('csrf')
  csrf(@Res({ passthrough: true }) response: Response) {
    return { csrfToken: this.auth.issueCsrf(response) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.rateLimit.assert(`login:${request.ip}`, 10, 15 * 60 * 1000);
    const input = loginSchema.parse(body);
    return this.auth.login(input.email, input.password, response);
  }

  @Public()
  @Post('refresh')
  @HttpCode(204)
  refresh(@Req() request: RequestContext, @Res({ passthrough: true }) response: Response) {
    return this.auth.refresh(
      request.cookies?.[PLATFORM_REFRESH_COOKIE] as string | undefined,
      response,
    );
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) response: Response): void {
    this.auth.logout(response);
  }

  @Get('me')
  me(@CurrentActor() actor: AuthenticatedActor) {
    return actor;
  }

  @Patch('profile')
  updateProfile(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() body: unknown,
    @Req() request: RequestContext,
  ) {
    return this.auth.updateProfile(actor, profileSchema.parse(body), request.requestId);
  }

  @Post('change-password')
  @HttpCode(204)
  changePassword(
    @CurrentActor() actor: AuthenticatedActor,
    @Body() body: unknown,
    @Req() request: RequestContext,
  ) {
    this.rateLimit.assert(`change-password:${actor.userId}`, 5, 60 * 60 * 1000);
    const input = changePasswordSchema.parse(body);
    return this.auth.changePassword(
      actor,
      input.currentPassword,
      input.newPassword,
      request.requestId,
    );
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Req() request: RequestContext) {
    this.rateLimit.assert(`forgot:${request.ip}`, 5, 60 * 60 * 1000);
    const input = emailSchema.parse(body);
    await this.auth.requestPasswordReset(input.email);
    return { message: 'If the account exists, password reset instructions will be sent.' };
  }

  @Public()
  @Post('activate')
  activate(
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.rateLimit.assert(`activate:${request.ip}`, 10, 15 * 60 * 1000);
    const input = activationSchema.parse(body);
    return this.auth.completeOtp(input.tokenHash, input.password, 'invite', response);
  }

  @Public()
  @Post('reset-password')
  reset(
    @Body() body: unknown,
    @Req() request: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.rateLimit.assert(`reset:${request.ip}`, 10, 15 * 60 * 1000);
    const input = activationSchema.parse(body);
    return this.auth.completeOtp(input.tokenHash, input.password, 'recovery', response);
  }
}
