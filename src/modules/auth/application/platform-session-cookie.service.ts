import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Environment } from '../../../common/config/environment';

export const PLATFORM_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type SessionCookiePayload = {
  refreshToken: string;
  expiresAt: number;
};

@Injectable()
export class PlatformSessionCookieService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  issue(refreshToken: string, expiresAt = Date.now() + PLATFORM_SESSION_TTL_MS): string {
    const payload = Buffer.from(JSON.stringify({ refreshToken, expiresAt })).toString('base64url');
    const unsigned = `v1.${payload}`;
    return `${unsigned}.${this.sign(unsigned)}`;
  }

  verify(value: string): SessionCookiePayload | null {
    const [version, encodedPayload, suppliedSignature, extra] = value.split('.');
    if (version !== 'v1' || !encodedPayload || !suppliedSignature || extra) return null;

    const unsigned = `${version}.${encodedPayload}`;
    const expected = Buffer.from(this.sign(unsigned));
    const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<SessionCookiePayload>;
      if (
        typeof payload.refreshToken !== 'string' ||
        !payload.refreshToken ||
        typeof payload.expiresAt !== 'number' ||
        !Number.isSafeInteger(payload.expiresAt)
      ) {
        return null;
      }
      return { refreshToken: payload.refreshToken, expiresAt: payload.expiresAt };
    } catch {
      return null;
    }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.get('COOKIE_SECRET', { infer: true }))
      .update(value)
      .digest('base64url');
  }
}
