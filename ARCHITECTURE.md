# Feliam architecture

## System shape

The product is one React application and one NestJS modular monolith. Event categories are configuration and data inside one generic Event domain.

```text
React/Vite
    |
    | HTTPS REST + authenticated Socket.IO tickets
    v
NestJS modular monolith
    |-- Supabase Auth
    |-- Supabase PostgreSQL + pgvector
    |-- private Supabase Storage
    |-- OpenAI Responses + embeddings
    `-- Resend or SMTP
```

NestJS is authoritative. React never queries Supabase business tables, handles Supabase credentials, or stores platform authentication tokens.

## Module boundaries

- `auth`: Supabase identity verification, backend-mediated sessions, profile updates, password change, activation and recovery
- `clients`: platform tenant lifecycle and initial client administration
- `memberships`: client roles, permissions and reusable authorization policy
- `events`: generic event aggregate, CQRS commands/queries, lifecycle and completeness
- `guests`: event-scoped guest records and deterministic CSV/XLSX imports
- `documents`: validation, private object storage and asynchronous ingestion
- `knowledge`: parameterized, event-filtered vector retrieval
- `concierge`: grounded organizer and guest conversations
- `invitations`: general access, QR, opaque personal invitations and mail jobs
- `guest-access`: restricted event/guest sessions that are separate from platform auth
- `audit`: sensitive operation history
- `dashboard`: role-aware operational summaries
- `health`: application/database readiness
- `infrastructure`: Prisma, providers, jobs, outbox and WebSockets

Large domain modules use domain/application/infrastructure/presentation separation. Controllers validate transport, resolve the actor and dispatch application behavior. Business invariants stay in services and command handlers.

## CQRS and state

`@nestjs/cqrs` is used for meaningful event/client state changes and canonical event queries. PostgreSQL is the source of truth; this is not event sourcing. Transactions group aggregate changes, audit records and outbox records where consistency matters.

## Tenancy and authorization

The hierarchy is Platform → Client → Event → operational resources. `Client` is an organization, not an authenticated role.

Platform actors are:

- `SUPER_ADMIN`
- active `CLIENT_ADMIN` membership
- active `CLIENT_STAFF` membership with explicit permissions

The policy layer evaluates the actor, target Client ownership, membership state and permission. Data access uses event/client-scoped predicates. Guests have an exact `GuestSession(eventId, guestId)` and cannot become platform actors.

The schema permits multiple client memberships for a user and leaves room for a future `EventMember` without changing identity/session architecture.

## Supabase Auth and cookies

Supabase owns credentials, verification, access/refresh issuance and recovery. NestJS receives login/refresh requests and writes credentials to HttpOnly cookies. React receives only a safe application user projection.

The backend validates each access credential through supported Supabase server APIs, maps the subject UUID to `User`, and then resolves memberships and permissions from PostgreSQL.

State-changing requests use a signed double-submit CSRF token, exact origin validation and credentialed CORS for a configured origin. Platform access, platform refresh, guest session and CSRF cookies have distinct names and purposes.

## PostgreSQL and pgvector

The normalized schema uses UUIDs, foreign keys, lifecycle enums, `timestamptz`, `citext`, uniqueness constraints and indexes aligned with access patterns. Flexible event/category metadata uses bounded JSONB while core ownership and operational records remain relational.

Semantic SQL includes `WHERE eventId = authorizedEventId` before ordering by vector distance. Parameters are passed with `Prisma.sql`; user input is never interpolated into raw SQL.

Prisma authorization remains mandatory. RLS is deliberately not claimed as a boundary when a hosted connection may use a bypass-capable role.

## Event completeness and source precedence

`EventCompletenessService` deterministically evaluates core fields, date order and IANA timezone validity. Every publish command rechecks readiness server-side.

Operational lifecycle (`UNSCHEDULED`, `UPCOMING`, `ONGOING`, `PAST`, `CANCELLED`) is derived from persisted status and UTC timestamps. Directory filters are tenant-scoped and cursor paginated. Mutation policy combines permission, client role, creator ownership and upcoming-state enforcement; names and time ranges are deliberately non-unique.

Source precedence is explicit organizer input over newer validated sources over older extracted facts. Model output is candidate data only. Zod validation and application commands execute before persistence.

## Documents and Supabase Storage

`FileStorage` is provider neutral. `SupabaseFileStorage` keeps documents in a private bucket through a backend-only Supabase client. The application stores object metadata and checksums in PostgreSQL, never binary files, and exposes only short-lived signed download URLs.

The ingestion path is authorization → file checks → checksum/deduplication → private upload → document/audit records → durable job → bounded parse → schema-constrained extraction → domain validation → structured facts/schedule → chunks/embeddings → event-scoped vector rows → readiness → WebSocket status.

Uploaded text, spreadsheet cells and retrieved chunks are untrusted data. Parser page/row/text/chunk limits bound resource use.

## Concierge and OpenAI

`AiProvider` isolates the official SDK. It configures model names in environment, uses Responses, structured JSON schema, timeouts, bounded retries and request correlation. The model has no database credentials or persistence tool.

Answer assembly prioritizes structured Event, Schedule, Location and Contact data. Semantic chunks supplement narrative questions. Exact guest-private context is loaded only for the authenticated event/guest when the question requires it. Missing information produces a natural unavailable answer instead of invention.

Conversation messages are persisted separately from event knowledge.

## Invitations and guest sessions

General access uses an event slug and asks only for name/email because the URL already identifies the event. Matching is event-scoped, email-primary and rate limited with a non-enumerating response.

Personal invitations use a 256-bit opaque secret. Public lookup stores only its hash. The mail worker creates the secret immediately before sending and retains an AES-GCM-encrypted retry copy until the selected email provider confirms delivery, allowing one stable delivery identifier to reproduce the same link after an ambiguous provider response. The encrypted copy is erased after delivery, and both token forms are erased after final failure. Exchange verifies expiry/revocation, creates an independently hashed guest session cookie and removes the sensitive token from the resulting browser URL.

Both general and personalized entry points require one name/email confirmation before session creation. Personalized confirmation is checked against the guest bound to the opaque invitation. Guest access opens at `Event.startAt` and closes exactly four hours after `Event.endAt`; the same policy is enforced during identification, invitation exchange, event reads and every guarded Concierge request. Closed links resolve to a not-started, ended or cancelled state without exposing guest data.

QR codes contain only safe public event or opaque invitation URLs, never PII. Guest mail uses a branded HTML template, an inline QR attachment and a clickable fallback URL.

## Durable side effects

Important workflows write an `OutboxEvent` in the same transaction as state changes. The outbox dispatcher creates idempotent PostgreSQL jobs. Workers implement claim ownership, attempts, bounded exponential backoff, completion/failure state and progress broadcasts.

No Redis or volatile-only queue is required.

## WebSockets

The browser requests a short-lived one-use ticket over authenticated, CSRF-protected HTTP. The Socket.IO gateway validates origin and consumes the ticket. Event room joins require the same server-side event/client authorization policy as REST.

Rooms are server-controlled (`event:{authorizedEventId}`); browser-supplied client/room identifiers are never trusted.

## Security boundaries

- external content never changes system instructions or actor permissions
- platform cookies are HttpOnly; guest and platform sessions are distinct
- invitation/session hashes and provider secrets are never serialized
- private guest free text can be AES-256-GCM encrypted with an environment key
- upload names never become filesystem or object paths
- exact credentialed CORS replaces wildcard origins
- Helmet, request IDs, normalized errors and Pino redaction are global
- audits preserve actual Super Admin actors and selected client/event context
- pagination and bounded retrieval protect large tenant datasets

## Intentionally deferred V2 seams

- event-specific staff assignments through a future `EventMember`
- optional guest email OTP before guest-session issuance
- access request approval/decline workflow for people not on a guest list
- distributed rate limiting if deployment topology outgrows process-local protection
- tested non-bypass database RLS as defense in depth
- richer document reprocessing/version administration
