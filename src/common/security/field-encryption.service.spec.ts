import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { FieldEncryptionService } from './field-encryption.service';

describe('FieldEncryptionService', () => {
  it('round trips sensitive guest information with authenticated encryption', () => {
    const config = { get: () => 'a-development-test-encryption-key' } as unknown as ConfigService<
      Environment,
      true
    >;
    const service = new FieldEncryptionService(config);
    const encrypted = service.encrypt('Room 402, private note');
    expect(encrypted).not.toContain('Room 402');
    expect(service.decrypt(encrypted)).toBe('Room 402, private note');
  });

  it('does not require a key for absent optional data', () => {
    const config = { get: () => '' } as unknown as ConfigService<Environment, true>;
    expect(new FieldEncryptionService(config).encrypt(undefined)).toBeNull();
  });
});
