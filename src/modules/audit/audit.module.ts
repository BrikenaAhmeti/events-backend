import { Global, Module } from '@nestjs/common';
import { AuditService } from './application/audit.service';

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
