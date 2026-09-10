import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Environment } from './common/config/environment';
import { normalizeOrigin } from './common/security/origin';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Environment, true>);
  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  const allowedOrigins = [
    config.get('FRONTEND_URL', { infer: true }),
    config.get('PUBLIC_APP_URL', { infer: true }),
  ].map(normalizeOrigin);
  app.enableCors({
    origin: [...new Set(allowedOrigins)],
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ transform: false, whitelist: false }));
  const swaggerConfig = new DocumentBuilder()
    .setTitle(`${config.get('PRODUCT_NAME', { infer: true })} API`)
    .setDescription('Canonical API for the event concierge platform')
    .setVersion('1.0')
    .addCookieAuth('event_access')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  app.enableShutdownHooks();
  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
