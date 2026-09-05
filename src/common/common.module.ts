import { Global, Module } from '@nestjs/common';
import { CsrfService } from './security/csrf.service';
import { FieldEncryptionService } from './security/field-encryption.service';
import { RateLimitService } from './security/rate-limit.service';
import { TokenService } from './security/token.service';

@Global()
@Module({
  providers: [CsrfService, TokenService, FieldEncryptionService, RateLimitService],
  exports: [CsrfService, TokenService, FieldEncryptionService, RateLimitService],
})
export class CommonModule {}
