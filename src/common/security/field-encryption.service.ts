import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Environment } from '../config/environment';
import { ApplicationError } from '../errors/application.error';

@Injectable()
export class FieldEncryptionService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  encrypt(value: string | undefined): string | null {
    if (!value) return null;
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  decrypt(value: string | null): string | null {
    if (!value) return null;
    const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  private key(): Buffer {
    const source = this.config.get('DATA_ENCRYPTION_KEY', { infer: true });
    if (!source) {
      throw new ApplicationError(
        503,
        'ENCRYPTION_NOT_CONFIGURED',
        'Sensitive data storage is unavailable.',
      );
    }
    return createHash('sha256').update(source).digest();
  }
}
