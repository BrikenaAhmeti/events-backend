import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import type { Environment } from '../../../common/config/environment';
import { ApplicationError } from '../../../common/errors/application.error';
import {
  CSRF_COOKIE,
  PLATFORM_ACCESS_COOKIE,
  PLATFORM_REFRESH_COOKIE,
} from '../../../common/security/cookie.constants';
import { CsrfService } from '../../../common/security/csrf.service';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { EmailProvider } from '../../../infrastructure/email/email.provider';
import { buildPasswordResetEmail } from '../../../infrastructure/email/account-emails';
import { emailBrand } from '../../../infrastructure/email/email-template';
import { AuditService } from '../../audit/application/audit.service';
import { SupabaseAuthProvider, type AuthSession } from '../infrastructure/supabase-auth.provider';
import {
  PLATFORM_SESSION_TTL_MS,
  PlatformSessionCookieService,
} from './platform-session-cookie.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly provider: SupabaseAuthProvider,
    private readonly prisma: PrismaService,
    private readonly csrf: CsrfService,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
    private readonly email: EmailProvider,
    private readonly sessionCookies: PlatformSessionCookieService,
  ) {}

  async login(email: string, password: string, response: Response) {
    const session = await this.provider.login(email, password);
    const user = await this.resolveApplicationUser(session.access_token);
    this.writeSession(response, session, Date.now() + PLATFORM_SESSION_TTL_MS);
    return this.toSafeUser(user);
  }

  async refresh(refreshCookie: string | undefined, response: Response): Promise<void> {
    const storedSession = refreshCookie ? this.sessionCookies.verify(refreshCookie) : null;
    if (!storedSession || storedSession.expiresAt <= Date.now()) {
      this.logout(response);
      throw new ApplicationError(401, 'SESSION_EXPIRED', 'Your session has expired.');
    }
    try {
      const session = await this.provider.refresh(storedSession.refreshToken);
      await this.resolveApplicationUser(session.access_token);
      this.writeSession(response, session, storedSession.expiresAt);
    } catch (error) {
      this.logout(response);
      throw error;
    }
  }

  logout(response: Response): void {
    response.clearCookie(PLATFORM_ACCESS_COOKIE, this.cookieOptions());
    response.clearCookie(PLATFORM_REFRESH_COOKIE, this.cookieOptions());
  }

  issueCsrf(response: Response): string {
    const token = this.csrf.issue();
    response.cookie(CSRF_COOKIE, token, {
      ...this.cookieOptions(),
      httpOnly: false,
      maxAge: 2 * 60 * 60 * 1000,
    });
    return token;
  }

  async requestPasswordReset(email: string): Promise<void> {
    const redirectTo = `${this.config.get('PUBLIC_APP_URL', { infer: true })}/reset-password`;
    try {
      const tokenHash = await this.provider.createPasswordResetToken(email, redirectTo);
      const url = `${redirectTo}?token_hash=${encodeURIComponent(tokenHash)}`;
      await this.email.send({
        to: email,
        ...buildPasswordResetEmail({
          brand: emailBrand(this.config),
          resetUrl: url,
        }),
        idempotencyKey: `password-reset-${tokenHash}`,
      });
    } catch {
      return;
    }
  }

  async completeOtp(
    tokenHash: string,
    password: string,
    type: 'invite' | 'recovery',
    response: Response,
  ) {
    const result = await this.provider.completeOtp(tokenHash, password, type);
    if (type === 'invite') {
      const user = await this.prisma.user.findUnique({ where: { supabaseUserId: result.user.id } });
      if (!user)
        throw new ApplicationError(
          403,
          'ACCOUNT_NOT_PROVISIONED',
          'This account is not provisioned.',
        );
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { status: 'ACTIVE' },
        }),
        this.prisma.clientMembership.updateMany({
          where: { userId: user.id, status: 'INVITED' },
          data: { status: 'ACTIVE', joinedAt: new Date() },
        }),
      ]);
    }
    const user = await this.resolveApplicationUser(result.session.access_token);
    this.writeSession(response, result.session, Date.now() + PLATFORM_SESSION_TTL_MS);
    return this.toSafeUser(user);
  }

  async updateProfile(
    actor: AuthenticatedActor,
    input: { firstName: string; lastName: string },
    requestId: string,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: actor.userId },
        data: input,
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: actor.memberships.find(({ status }) => status === 'ACTIVE')?.clientId,
          action: 'USER_PROFILE_UPDATED',
          entityType: 'User',
          entityId: actor.userId,
          requestId,
          metadata: {},
        },
      });
    });
    return this.toSafeUser(await this.loadApplicationUser(actor.userId));
  }

  async changePassword(
    actor: AuthenticatedActor,
    currentPassword: string,
    newPassword: string,
    requestId: string,
  ): Promise<void> {
    if (currentPassword === newPassword) {
      throw new ApplicationError(
        400,
        'PASSWORD_UNCHANGED',
        'Choose a password you have not already used here.',
      );
    }
    await this.provider.changePassword(actor.email, currentPassword, newPassword);
    await this.audit.record({
      actorUserId: actor.userId,
      clientId: actor.memberships.find(({ status }) => status === 'ACTIVE')?.clientId,
      action: 'USER_PASSWORD_CHANGED',
      entityType: 'User',
      entityId: actor.userId,
      requestId,
    });
  }

  private async resolveApplicationUser(accessToken: string) {
    const identity = await this.provider.verify(accessToken);
    return this.loadApplicationUserByIdentity(identity.id);
  }

  private async loadApplicationUserByIdentity(supabaseUserId: string) {
    const user = await this.prisma.user.findUnique({
      relationLoadStrategy: 'join',
      where: { supabaseUserId },
      include: {
        memberships: {
          include: { permissions: true, client: { select: { status: true } } },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new ApplicationError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
    }
    return user;
  }

  private async loadApplicationUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      relationLoadStrategy: 'join',
      where: { id: userId },
      include: {
        memberships: {
          include: { permissions: true, client: { select: { status: true } } },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new ApplicationError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
    }
    return user;
  }

  private writeSession(response: Response, session: AuthSession, expiresAt: number): void {
    const remainingSessionMs = Math.max(0, expiresAt - Date.now());
    response.cookie(PLATFORM_ACCESS_COOKIE, session.access_token, {
      ...this.cookieOptions(),
      maxAge: Math.min(session.expires_in * 1000, remainingSessionMs),
    });
    response.cookie(
      PLATFORM_REFRESH_COOKIE,
      this.sessionCookies.issue(session.refresh_token, expiresAt),
      {
        ...this.cookieOptions(),
        maxAge: remainingSessionMs,
      },
    );
  }

  private cookieOptions(): CookieOptions {
    const production = this.config.get('NODE_ENV', { infer: true }) === 'production';
    const domain = this.config.get('COOKIE_DOMAIN', { infer: true });
    const sameSite = this.config.get('COOKIE_SAME_SITE', { infer: true });
    return {
      httpOnly: true,
      secure: production,
      sameSite,
      path: '/',
      ...(domain ? { domain } : {}),
    };
  }

  private toSafeUser(user: Awaited<ReturnType<AuthService['resolveApplicationUser']>>) {
    return {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      platformRole: user.platformRole,
      memberships: user.memberships
        .filter((membership) => membership.client.status === 'ACTIVE')
        .map((membership) => ({
          id: membership.id,
          clientId: membership.clientId,
          role: membership.role,
          status: membership.status,
          permissions: membership.permissions.map(({ permission }) => permission),
        })),
    };
  }
}
