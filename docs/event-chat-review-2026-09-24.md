# Event creation and guest chat review

Reviewed against the requested behavior on 24 September 2026. Changes are local in the backend and frontend repositories; they have not been deployed.

## Creator chat

- Super administrators choose and confirm the client before starting. **New chat** clears that choice and returns to the first step. Client administrators and staff use their authorized client context.
- Creation and publication require a name, type, purpose/description, venue or destination, start, end, timezone, organizer name and organizer email. Invalid date ordering and timezones are rejected by the backend.
- Messages and supported files populate a persisted draft. Document details must be reviewed before creation; missing information is requested in chat. Instructions contained in source files are treated as untrusted content.
- Missing names receive a suggestion with **Accept** and **Reject**. Rejection opens one name input. These actions save explicit decisions without asking the language model to interpret button clicks.
- Event classification and venue guidance include indoor directions, restroom locations, accessibility, parking and Wi-Fi when supplied. The ready message invites these details.
- Duplicate names and overlapping event times are allowed, including within one client. Only the public slug is unique.
- Published events expose their general link and QR in the organizer chat. Publishing queues personal invitations for every registered guest who does not already have a queued/sent/accepted invitation. Queue insertion is batched and atomic with publication.
- Staff can read all events in their client, and can mutate only their own upcoming events with the relevant permission. Client administrators can manage all upcoming events in their client. The same ownership/time checks cover guests, invitations, documents and event details. Explicit staff permissions still apply.
- Event tables support name, client (super administrator), creator, lifecycle, workflow status, single date and date range filters, with cursor pagination. Super administrators default to all clients.

## Guest chat

- Personal invitations contain an opaque random token associated with the guest and event. Stored access/session secrets are hashed; the temporary token used for sending is encrypted. No guest identity is encoded in the URL.
- Personal and general links both ask for full name and email in one message. The backend must match a registered guest before issuing a session. Unicode names are compared without the former ASCII-only normalization bug.
- Personal links can be used again with identity confirmation until expiry. Previously consumed links whose token hashes were already deleted by the old implementation cannot be recovered automatically.
- Both entry routes and every guest event/history/question request require a published event between its start and its end plus four hours. Cancelled, future and closed events cannot open the chat. An already open page closes at the cutoff and refreshes cancellation state.
- Answers receive authorized event fields, shared schedule items, event-scoped document search, and the current guest's relevant private arrangements. Other guests' identities/roster data are filtered before model input and before answers are streamed.
- Recent completed messages from the same guest/event or organizer/event conversation support follow-up questions. Current confirmed event details take precedence. History reload returns the latest 100 messages in chronological order. Guest caches are cleared when identity changes.
- Public organizer contact details and ordinary shared guidance such as “all guests should use the east entrance” remain available. Staff-only schedule entries are excluded.
- The interface contains no AI/OpenAI/GPT labels; response instructions prohibit implementation jargon and require uncertainty when event information is absent.

## Invitations

The responsive HTML and plain-text invitation include the Feliam logo, host company in the header/footer, personal greeting, dates/timezone, venue, personal arrangements, a QR image, a primary link button, fallback URL and support details. This is platform branding with the host's company name; the current client model has no custom logo setting.

The QR and button use the same personal URL. Cancelled/unpublished or expired events are skipped by the sender. Sending uses durable jobs with bounded retries. The scheduler endpoint is protected by `CRON_SECRET`.

## Verification

- Backend unit/service/application checks, frontend unit/component checks, type checks, lint and production builds passed.
- Desktop and mobile browser scenarios covered client confirmation, name rejection/custom naming, creating an event workspace, document upload, guest import, publication, QR/link display, event filters and pagination, both guest entry routes, closed event states, and the live four-hour cutoff.
- Three read-only database integration checks passed, including tenant scope and cursor page results. No database records were changed by these checks.
- The configured model successfully extracted a synthetic complete brief, including category, guest and indoor venue details.
- A real generated DOCX was parsed and analyzed with the configured model. Missing times, timezone and organizer email remained missing and the response asked for the start time.
- A live grounded-answer check answered restroom/contact questions from supplied facts and ignored a hostile instruction placed in document context.
- SMTP connection, encrypted transport and authentication passed. No email was sent to an actual guest.
- The invitation was rendered and visually inspected at desktop and mobile widths, with no horizontal overflow. This does not substitute for testing in Gmail/Outlook or verifying inbox delivery.

## Deployment and practical limits

- Deploy both repositories to use these changes. No migration is required by this patch.
- On a serverless backend, configure the authenticated scheduled retry trigger described in the README. Its production schedule and secret have not been provisioned. Continuously running servers already poll the queue.
- Verify one real invitation in an authorized test inbox after deployment, including QR scanning, button access and mail-domain alignment.
- Setup supports text-based PDF, DOCX, TXT, CSV and XLSX documents. Image-only scans need a text version; there is no OCR step. Each setup message/file is limited to 60,000 extracted characters, with an explicit error instead of silently truncating the latest content.
- Setup chat supports up to 500 guests. For larger lists use the Guests import after workspace creation, up to 5,000 rows per CSV/XLSX file. Multiple imports are supported; oversized spreadsheets now report an error rather than silently omitting guests.
- Model responses remain probabilistic. Document confirmation, required-field validation, authorization, identity checks and access-window enforcement are deterministic backend checks.
