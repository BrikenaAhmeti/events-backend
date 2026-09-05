import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/database/prisma.service';

describe('HTTP application boundary', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: () => Promise.resolve(),
        $disconnect: () => Promise.resolve(),
        $queryRaw: () => Promise.resolve([{ result: 1 }]),
      })
      .compile();

    app = module.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports application and database readiness', async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server).get('/api/v1/health').expect(200);
    const body = JSON.parse(response.text) as unknown;
    expect(body).toMatchObject({
      status: 'ready',
      checks: { application: 'up', database: 'up' },
    });
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('rejects state changes without a valid CSRF token', async () => {
    const server = app.getHttpServer() as Server;
    const response = await request(server)
      .post('/api/v1/auth/logout')
      .set('origin', 'http://localhost:5173')
      .expect(403);
    const body = JSON.parse(response.text) as unknown;
    expect(body).toMatchObject({
      statusCode: 403,
      code: 'CSRF_VALIDATION_FAILED',
    });
  });

  it('rejects a valid CSRF token presented from another origin', async () => {
    const server = app.getHttpServer() as Server;
    const agent = request.agent(server);
    const csrfResponse = await agent.get('/api/v1/auth/csrf').expect(200);
    const csrf = JSON.parse(csrfResponse.text) as { csrfToken: string };
    const response = await agent
      .post('/api/v1/auth/logout')
      .set('origin', 'https://attacker.example')
      .set('x-csrf-token', csrf.csrfToken)
      .expect(403);
    const body = JSON.parse(response.text) as unknown;
    expect(body).toMatchObject({ statusCode: 403, code: 'ORIGIN_NOT_ALLOWED' });
  });
});
