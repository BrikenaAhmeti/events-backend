import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { LoggerModule } from 'nestjs-pino';
import { CommonModule } from './common/common.module';
import { validateEnvironment } from './common/config/environment';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { CsrfMiddleware } from './common/security/csrf.middleware';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { PlatformAuthGuard } from './modules/auth/presentation/platform-auth.guard';
import { ClientsModule } from './modules/clients/clients.module';
import { ConciergeModule } from './modules/concierge/concierge.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { EventsModule } from './modules/events/events.module';
import { GuestAccessModule } from './modules/guest-access/guest-access.module';
import { GuestsModule } from './modules/guests/guests.module';
import { HealthModule } from './modules/health/health.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { EmailModule } from './infrastructure/email/email.module';
import { JobsModule } from './infrastructure/jobs/jobs.module';
import { ServerlessJobRunner } from './infrastructure/jobs/serverless-job-runner.service';
import { ServerlessJobsInterceptor } from './infrastructure/jobs/serverless-jobs.interceptor';
import { ScheduledJobsController } from './infrastructure/jobs/scheduled-jobs.controller';
import { OpenAiModule } from './infrastructure/openai/openai.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { WebsocketModule } from './infrastructure/websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.x-csrf-token',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'req.body.token',
            'req.body.tokenHash',
            'res.headers.set-cookie',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
    CqrsModule,
    CommonModule,
    DatabaseModule,
    JobsModule,
    StorageModule,
    EmailModule,
    OpenAiModule,
    AuditModule,
    AuthModule,
    MembershipsModule,
    ClientsModule,
    EventsModule,
    DashboardModule,
    GuestsModule,
    DocumentsModule,
    GuestAccessModule,
    ConciergeModule,
    InvitationsModule,
    WebsocketModule,
    HealthModule,
  ],
  controllers: [ScheduledJobsController],
  providers: [
    { provide: APP_GUARD, useExisting: PlatformAuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    ServerlessJobRunner,
    { provide: APP_INTERCEPTOR, useClass: ServerlessJobsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, CsrfMiddleware).forRoutes('*');
  }
}
