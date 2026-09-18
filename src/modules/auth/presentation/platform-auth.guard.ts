import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApplicationError } from '../../../common/errors/application.error';
import { PLATFORM_ACCESS_COOKIE } from '../../../common/security/cookie.constants';
import type { RequestContext } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { IS_PUBLIC } from '../../../common/decorators/public.decorator';
import { SupabaseAuthProvider } from '../infrastructure/supabase-auth.provider';

@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly provider: SupabaseAuthProvider,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<RequestContext>();
    const token = request.cookies?.[PLATFORM_ACCESS_COOKIE] as string | undefined;
    if (!token) throw new ApplicationError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    const identity = await this.provider.verify(token);
    const user = await this.prisma.user.findUnique({
      relationLoadStrategy: 'join',
      where: { supabaseUserId: identity.id },
      include: {
        memberships: {
          include: { permissions: true, client: { select: { status: true } } },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE')
      throw new ApplicationError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
    request.actor = {
      userId: user.id,
      supabaseUserId: user.supabaseUserId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      platformRole: user.platformRole,
      memberships: user.memberships
        .filter((membership) => membership.client.status === 'ACTIVE')
        .map((membership) => ({
          clientId: membership.clientId,
          role: membership.role,
          status: membership.status,
          permissions: membership.permissions.map(({ permission }) => permission),
        })),
    };
    return true;
  }
}
