import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../../common/errors/application.error';
import { GUEST_SESSION_COOKIE } from '../../../common/security/cookie.constants';
import { TokenService } from '../../../common/security/token.service';
import type { RequestContext } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { GuestAccessWindowService } from '../application/guest-access-window.service';

@Injectable()
export class GuestSessionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly accessWindow: GuestAccessWindowService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestContext>();
    const raw = request.cookies?.[GUEST_SESSION_COOKIE] as string | undefined;
    const eventId = String(request.params.eventId ?? '');
    if (!raw || !eventId)
      throw new ApplicationError(401, 'GUEST_SESSION_REQUIRED', 'Guest access is required.');
    const session = await this.prisma.guestSession.findFirst({
      where: {
        tokenHash: this.tokens.hash(raw),
        eventId,
      },
      include: { event: { select: { status: true, startAt: true, endAt: true } } },
    });
    if (!session)
      throw new ApplicationError(401, 'GUEST_SESSION_INVALID', 'Guest access has expired.');
    this.accessWindow.assertActive(session.event);
    if (session.revokedAt || session.expiresAt <= new Date())
      throw new ApplicationError(401, 'GUEST_SESSION_INVALID', 'Guest access has expired.');
    request.guestActor = {
      sessionId: session.id,
      guestId: session.guestId,
      eventId: session.eventId,
    };
    await this.prisma.guestSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });
    return true;
  }
}
