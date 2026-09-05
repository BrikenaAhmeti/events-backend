# Feliam backend

Production-oriented NestJS API for the multi-tenant Feliam event concierge product. The backend is authoritative for authentication mediation, authorization, tenant isolation, event state, guest access, documents, knowledge retrieval, invitations, jobs and audit history.

## Stack

- Node.js 22 LTS and pnpm
- NestJS modular monolith with `@nestjs/cqrs`
- Prisma and Supabase-hosted PostgreSQL
- `pgvector` for event-scoped semantic retrieval
- Supabase Auth for platform identity
- private Cloudflare R2 storage through the S3-compatible API
- OpenAI Responses API and embeddings behind an `AiProvider`
- Resend or SMTP behind an `EmailProvider`
- Socket.IO through a NestJS gateway
- PostgreSQL-backed jobs and transactional outbox
- Vitest, ESLint, Prettier and strict TypeScript

No Docker, Redis, local PostgreSQL, MinIO, Supabase Storage, Supabase Realtime, external vector database, GraphQL or microservices are required.

## Quick start

```bash
cd /Users/brikenaahmeti/events-ai-backend
corepack enable
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

The API listens on `http://localhost:3000/api/v1`. Swagger is available at `http://localhost:3000/api/docs`.

## Vercel deployment

The checked-in Vercel configuration uses the NestJS framework preset, uses the Hobby plan's five-minute Fluid compute limit for streamed and post-response work, and generates Prisma Client during installation.

1. Create a Vercel project with this backend directory as its root.
2. Add every required production variable from `.env.example`.
3. Set `NODE_ENV=production`, `FRONTEND_URL` to the exact deployed frontend origin and `PUBLIC_APP_URL` to the same frontend URL.
4. Keep `COOKIE_DOMAIN` empty. If frontend and backend use separate `.vercel.app` project domains, set `COOKIE_SAME_SITE=none`. With `app.yourdomain.com` and `api.yourdomain.com`, `lax` is preferred.
5. Apply the production migration once from a trusted machine with `pnpm db:migrate:deploy`.
6. Deploy with `pnpm dlx vercel`, then promote with `pnpm dlx vercel --prod`.

For SMTP on Vercel, use port `465` or `587`, not port `25`. The durable PostgreSQL queues are drained with Vercel's post-response runtime while normal long-running deployments retain their timer-based workers. Concierge answers stream directly over authenticated HTTP and do not rely on a WebSocket connection. Socket.IO remains a best-effort enhancement for document, invitation and event progress updates.

## Supabase setup

1. Create a development Supabase project.
2. Open Project Settings → Database and copy the pooled runtime connection into `DATABASE_URL`.
3. Copy the direct/session connection into `DIRECT_DATABASE_URL`. Prisma migrations must use a connection that supports DDL and is not transaction-pooled.
4. Copy the project URL, publishable key and backend-only secret key into the matching variables.
5. Configure the frontend application URL as an allowed Auth redirect URL.
6. Run `pnpm db:migrate:deploy`. The migration enables `citext` and `vector` and creates the HNSW vector index.

Prisma application authorization is the primary database access boundary. This implementation does not represent Supabase RLS as protecting a Prisma connection that may use a bypass-capable role. If RLS is added later, use and test a non-bypass database role while retaining all NestJS policies.

## Cloudflare R2 setup

1. Create a private R2 bucket.
2. Create a scoped API token with object read/write/delete only for that bucket.
3. Fill `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

Object keys are server generated and tenant/event scoped. Original filenames are metadata only. Downloads use short-lived signed URLs. Browser code never receives R2 credentials.

## Email setup

SMTP is the default provider. Fill `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `EMAIL_FROM`. Port `587` normally uses `SMTP_SECURE=false` with STARTTLS; port `465` normally uses `SMTP_SECURE=true`. Vercel blocks outbound SMTP port `25`, so use `465` or `587`. Staff and guest mail is processed by the PostgreSQL worker with stable message identifiers and bounded retries. Password recovery uses a Supabase-generated recovery token delivered through the same selected `EmailProvider`, so the application SMTP configuration covers account recovery too.

Resend remains an optional alternative. Set `EMAIL_PROVIDER=resend`, verify a sending domain and fill `RESEND_API_KEY` and `EMAIL_FROM` only if you choose it later.

Guest invitations are rendered as responsive branded HTML with the Feliam identity, the client organization, event summary, inline QR attachment, primary action button, full fallback link and footer. One independently generated personalized URL is sent per unsent guest. The URL and QR carry only an opaque random token and no guest PII.

## OpenAI setup

Create a project-scoped API key and fill:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

The implementation uses the official Node SDK and Responses API. Model-produced extraction is schema validated. Application commands and domain rules remain authoritative. Retrieved document text is explicitly treated as untrusted data, and vector retrieval applies the event filter inside SQL.

If a different embedding model changes vector dimensions, update the `DocumentChunk.embedding` dimension and migrate before switching the environment variable.

## Environment variables

| Variable                   | Required for                | Notes                                             |
| -------------------------- | --------------------------- | ------------------------------------------------- |
| `NODE_ENV`                 | runtime                     | `development`, `test` or `production`             |
| `PRODUCT_NAME`             | product copy                | defaults to `Feliam`                              |
| `PORT`                     | runtime                     | defaults to `3000`                                |
| `FRONTEND_URL`             | HTTP and WebSocket security | exact allowed browser origin                      |
| `PUBLIC_APP_URL`           | links                       | public frontend base URL                          |
| `DATABASE_URL`             | application                 | Supabase pooled PostgreSQL URL                    |
| `DIRECT_DATABASE_URL`      | migrations                  | Supabase direct/session PostgreSQL URL            |
| `SUPABASE_URL`             | platform auth               | Supabase project URL                              |
| `SUPABASE_PUBLISHABLE_KEY` | platform auth               | backend-held publishable key                      |
| `SUPABASE_SECRET_KEY`      | administrative auth         | backend only; never use a `VITE_` prefix          |
| `OPENAI_API_KEY`           | Concierge                   | backend only                                      |
| `OPENAI_MODEL`             | Concierge                   | defaults to `gpt-5.6`                             |
| `OPENAI_EMBEDDING_MODEL`   | knowledge                   | defaults to `text-embedding-3-small`              |
| `R2_ACCOUNT_ID`            | reference                   | Cloudflare account identifier                     |
| `R2_ENDPOINT`              | documents                   | S3-compatible endpoint                            |
| `R2_BUCKET`                | documents                   | private bucket name                               |
| `R2_ACCESS_KEY_ID`         | documents                   | backend only                                      |
| `R2_SECRET_ACCESS_KEY`     | documents                   | backend only                                      |
| `EMAIL_PROVIDER`           | email                       | `smtp` by default; `resend` remains optional      |
| `RESEND_API_KEY`           | Resend email                | required only when `EMAIL_PROVIDER=resend`        |
| `EMAIL_FROM`               | email                       | verified sender                                   |
| `SMTP_HOST`                | SMTP email                  | SMTP server hostname                              |
| `SMTP_PORT`                | SMTP email                  | defaults to `587`                                 |
| `SMTP_SECURE`              | SMTP email                  | `true` for implicit TLS, otherwise STARTTLS       |
| `SMTP_USER`                | SMTP email                  | backend only                                      |
| `SMTP_PASSWORD`            | SMTP email                  | backend only                                      |
| `COOKIE_SECRET`            | CSRF                        | at least 32 random characters                     |
| `COOKIE_DOMAIN`            | production cookies          | leave blank on localhost                          |
| `COOKIE_SAME_SITE`         | production cookies          | use `none` for separate Vercel preview domains    |
| `DATA_ENCRYPTION_KEY`      | sensitive guest fields      | high-entropy secret; rotation needs a data plan   |
| `TEST_DATABASE_URL`        | integration tests           | use a disposable non-production database          |
| `DEMO_*_EMAIL`             | seed identities             | optional demo addresses                           |
| `DEMO_*_PASSWORD`          | Supabase demo users         | required only to provision usable Auth identities |

Generate secrets with a cryptographically secure secret manager or `openssl rand -base64 48`. Never commit `.env`.

## Database commands

```bash
pnpm prisma:generate
pnpm db:migrate
pnpm db:migrate:deploy
pnpm db:seed
pnpm db:studio
```

The checked-in migration is canonical and includes PostgreSQL extensions, normalized constraints, tenant-aware indexes and the vector index.

## Demo seed

The seed is idempotent for business records and creates:

- platform administrator Mara Ellis
- Northstar Events
- client administrator Elena Hart
- client staff member Theo James with operational permissions
- published fictional `Presidents Club Mallorca`
- published fictional `Global Leadership Forum`
- realistic schedules, event facts and fictional guests/delegates

To create matching Supabase Auth users, provide `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and all three demo passwords before running `pnpm db:seed`. Without them, deterministic placeholder subject UUIDs are used for database-only demos; login will not work until real Supabase identities are provisioned.

To create only the working Super Admin identity and database record, set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DEMO_SUPER_ADMIN_EMAIL`, and `DEMO_SUPER_ADMIN_PASSWORD`, then run:

```bash
pnpm db:seed:admin
```

This focused command fails safely if any credential required for a real login is missing. The default email is `super.admin@example.test`; the password is always the value supplied through `DEMO_SUPER_ADMIN_PASSWORD` and is never committed to source control.

## API and security model

All routes are under `/api/v1`.

- platform auth: `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/profile`, `/auth/change-password`, `/auth/csrf`
- account recovery/activation: `/auth/forgot-password`, `/auth/reset-password`, `/auth/activate`
- clients/team: `/clients`, `/clients/:clientId/team`
- events: `/events`, `/events/:eventId`, `/events/:eventId/cancel`, `/events/directory/clients`, `/events/directory/creators`
- guided setup analysis: `/events/setup/analyze`
- operations: guests, documents, Concierge, schedule and invitations below an exact event
- public access: `/public/events/:slug`, `/public/invitations/preview`, `/public/invitations/exchange`
- guest access: `/guest/events/:eventId`
- readiness: `/health`

Supabase access and refresh credentials are stored only in distinct HttpOnly cookies. State-changing browser requests require the signed double-submit CSRF token in `X-CSRF-Token` and pass exact Origin/Referer validation. Frontend code never receives or decodes platform tokens.

Authorization evaluates platform role, active membership, effective permission and resource ownership. Tenant-sensitive queries resolve the event/client relationship before data access. Guest sessions and invitation tokens are opaque random secrets; only SHA-256 hashes are stored. Sensitive guest free text uses AES-256-GCM application-layer encryption when present.

The event directory supports client, creator, lifecycle, exact-day, date-range and event-name filters with cursor pagination. Client staff can read all events in their tenant according to `EVENT_READ`, but can change, cancel or delete only their own upcoming events. Client administrators can manage every upcoming event in their tenant. Completed events remain immutable operational history. Duplicate event names and overlapping schedules are intentionally allowed.

The API returns normalized safe errors:

```json
{
  "statusCode": 400,
  "code": "EVENT_VALIDATION_FAILED",
  "message": "Event information is incomplete.",
  "details": {},
  "requestId": "correlation-id"
}
```

Logs redact cookies, credentials, password and token fields. Audit records retain the actual actor, including Super Admin cross-client operations.

## Documents and knowledge

Uploads validate extension, MIME, signature, Office archive expansion, size and parser limits before storage. Original binaries remain in private R2. A PostgreSQL job extracts text, validates candidate event details, applies deterministic source precedence, chunks narrative content, creates embeddings, stores provenance, updates readiness and emits progress over Socket.IO.

Text and file setup analysis classify the generic event category, capture mandatory fields, extract schedules and venue guidance such as address, entrances, rooms, floors, restrooms, accessibility, parking and Wi-Fi, and return deterministic missing-field results. When no explicit event name exists, the setup flow returns a suggested name for explicit acceptance or rejection.

Structured dates, schedules, contacts and guest records are queried directly. Narrative knowledge uses event-scoped vector retrieval. Conversation history is persisted separately and is never authoritative event data.

## Jobs, outbox and WebSockets

`BackgroundJob` provides durable state, idempotency, retry, exponential backoff, stale-lease recovery, progress and safe recovery without Redis. Job records are written atomically with documents and memberships. `OutboxEvent` keeps event publication and invitation batches in the same transaction as their follow-up work. Workers claim jobs with conditional updates so multiple instances cannot process one pending row simultaneously. Invitation delivery secrets are encrypted only while an email job can retry, then erased after successful delivery or final failure; public lookup retains only the token hash for successfully sent invitations.

The `/events` Socket.IO namespace accepts one-use, one-minute tickets issued by the authenticated backend. The server validates the exact frontend origin and authorizes the event before joining a server-controlled room.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm audit --prod
pnpm build
```

Database integration tests must use `TEST_DATABASE_URL` and are intentionally separable. Provider live tests require dedicated non-production Supabase, R2, the selected email provider and OpenAI credentials.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and design decisions.
