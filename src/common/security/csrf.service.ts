import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Environment } from '../config/environment';

@Injectable()
export class CsrfService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  issue(): string {
    const nonce = randomBytes(32).toString('base64url');
    return `${nonce}.${this.sign(nonce)}`;
  }

  verify(token: string): boolean {
    const [nonce, signature] = token.split('.');
    if (!nonce || !signature) return false;
    const expected = Buffer.from(this.sign(nonce));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.get('COOKIE_SECRET', { infer: true }))
      .update(value)
      .digest('base64url');
  }
}
