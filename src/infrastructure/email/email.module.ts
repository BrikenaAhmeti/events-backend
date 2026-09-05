import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../common/config/environment';
import { EmailProvider } from './email.provider';
import { ResendEmailProvider } from './resend-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

@Global()
@Module({
  providers: [
    ResendEmailProvider,
    SmtpEmailProvider,
    {
      provide: EmailProvider,
      inject: [ConfigService, ResendEmailProvider, SmtpEmailProvider],
      useFactory: (
        config: ConfigService<Environment, true>,
        resend: ResendEmailProvider,
        smtp: SmtpEmailProvider,
      ) => (config.get('EMAIL_PROVIDER', { infer: true }) === 'smtp' ? smtp : resend),
    },
  ],
  exports: [EmailProvider],
})
export class EmailModule {}
