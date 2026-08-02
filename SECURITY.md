# SettleFlow Security Policy

SettleFlow is a finance-grade simulation and engineering case study. These documented controls do not establish that the project is secure, compliant, certified, or suitable for real payment processing. Never use the project for live funds or regulated payment-authentication data without independent security, compliance, financial, and operational review.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include exploit details, secrets, or sensitive data in a public pull request.

Report privately to **[SECURITY CONTACT TO BE DECIDED]** using **[PRIVATE REPORTING CHANNEL TO BE DECIDED]**. Include the affected version or commit, impact, reproduction steps, and any suggested mitigation. Use only synthetic data. Project maintainers must define acknowledgement, triage, remediation, disclosure, and supported-version expectations before the first public release.

If no private channel is published, do not post vulnerability details publicly. Contact the repository owner through a non-sensitive public channel only to request private reporting instructions.

## Secrets and credentials

- Commit placeholders in safe example environment files; never commit usable credentials, production configuration, API keys, tokens, webhook secrets, encryption keys, certificates, recovery codes, or secret-bearing logs.
- Load local secrets through ignored environment files. Production-like deployments must use a managed secret store or KMS and audit access.
- Generate API keys with a non-secret lookup prefix and high-entropy secret. Display the secret only at creation or rotation and store only a slow hash plus lookup metadata.
- Webhook signing secrets are encrypted at rest with AES-256-GCM and endpoint-bound authenticated data. Keep keyring material outside the database and repository. Rotation retains the encrypted previous secret for the approved 24-hour overlap; plaintext is disclosed only in the successful create or rotation response.
- Revoke and rotate exposed material immediately, then inspect history, logs, artifacts, and dependent systems. Removing a secret from the latest commit is not sufficient.
- Run secret scanning in local/CI workflows and before release. Treat a finding as blocking until proven false or remediated.

## Authentication and authorization

- Merchant APIs use hashed, scoped, rotatable API keys. Unknown, disabled, revoked, or out-of-scope keys fail closed.
- Operator APIs require separate authentication and explicit authorization. Privileged actions must capture actor, action, target, reason, timestamp, and correlation ID in the append-only audit trail.
- Enforce tenant ownership in each database predicate using the authenticated merchant ID. Do not fetch broadly and filter after retrieval.
- Apply least privilege to application roles, migrations, worker queue permissions, network access, telemetry access, and operator capabilities. Financial and audit records require restricted update/delete permissions.
- API and worker database access uses the non-owner `settleflow_app` role. Migration and provisioning use a distinct owner credential; the runtime role cannot update, delete, or truncate lifecycle audit.
- Protect internal readiness and metrics endpoints from public access by default.

## Validation and resource controls

- Validate authentication, ownership, type, length, format, allowed state, currency, amount range, and business semantics before acting.
- Use integer minor units for money. Reject overflow, non-positive capture/refund amounts, unsupported currencies, currency mismatch, and cumulative refunds above captured value.
- Use parameterized database access. Review every raw SQL query used for locks, claims, constraints, or tenant-scoped access.
- Bound JSON body size, pagination, timeouts, concurrency, retries, and response/error detail.
- Treat reconciliation CSV as untrusted: enforce file size, row count, encoding, schema, checksum, streaming/resource limits, deterministic duplicate handling, and formula-neutral exports. Do not log row contents.

## Webhook security

- Sign the exact serialized UTF-8 request bytes with HMAC-SHA-256 using the endpoint secret. Include the unique delivery ID, stable event ID, schema version, and timestamp; compare signatures in constant time.
- During the 24-hour rotation overlap, send the current signature first and the eligible previous-secret signature second. Select versions at durable attempt start, keep plaintext only in memory, and never persist or log signatures or decrypted secrets.
- Example consumers must enforce the documented five-minute default recency window, validate identifiers, and deduplicate delivery/event processing. Manual replay creates a new delivery ID and records the authorized actor and reason.
- Do not follow redirects. Use HTTPS in production-like environments, allow only approved ports, and apply outbound egress restrictions.
- Validate and normalize the URL at registration and re-resolve DNS immediately before delivery. Block loopback, private, link-local, multicast/reserved ranges, cloud metadata targets, and any resolved address that violates policy. Defend against DNS rebinding and IPv4/IPv6 representation tricks.
- Pin one approved resolved address per attempt while preserving the canonical host for HTTP Host, TLS SNI, and certificate verification. Bound the complete attempt to eight seconds and consume no more than 64 KiB of response data.
- Keep full webhook payloads and response bodies out of logs by default. Store bounded, redacted attempt evidence.
- Treat RabbitMQ payloads and metadata as untrusted. The Webhook projection consumer enforces the exact `payment.created.v1` contract and a 16 KiB body limit before persistence, logs only stable identifiers/error codes, and sends invalid or unsupported messages to the approved DLQ.
- Preserve `inbox_messages`, retained Webhook event markers, delivery lifecycle state, and immutable delivery-attempt rows as security/audit evidence. Runtime delivery updates are owner-conditioned and least-privilege; do not manually update, delete, truncate, purge, reopen, or replay this evidence.

## Sensitive data and logging

Use only synthetic merchants, payments, statements, destinations, credentials, screenshots, logs, and traces in the repository and reference environments.

Never log or expose authorization headers, raw API keys, idempotency-key values, signing secrets, encryption material, raw financial request bodies, CSV row contents, full webhook payloads by default, full response bodies, stack traces in public API responses, or internal network details. Structured telemetry may contain sanitized route templates, status, duration, merchant/request/event/delivery IDs, and stable error codes.

Apply retention limits to operational data and purge in bounded jobs. Do not use telemetry as an authoritative financial store.

## Engineering and dependency controls

- Require security review for every payment-changing operation and every change to authentication, authorization, secrets, tenant isolation, webhook delivery, reconciliation import, audit logging, database privileges, or recovery behavior.
- Test tenant isolation, API-key lifecycle, known webhook signature vectors, stale/replayed signatures, SSRF URL/DNS corpora, CSV abuse, message poisoning, and secret/log redaction.
- Pin dependency versions in the lockfile and pin workflow/container references by digest where supported. Run dependency review, SAST, secret scanning, and container scanning; investigate high-severity findings before merge or release.
- Do not add a production dependency without explaining its purpose, trust boundary, maintenance status, license, failure behavior, and security impact. Record material architecture changes in an ADR.
- Preserve database constraints, immutable ledger/audit controls, and their negative tests. Security controls must not be disabled to make an implementation pass.

See [the architecture overview](docs/architecture/README.md), [financial invariants](docs/architecture/financial-invariants.md), and [review checklist](docs/review/code-review-checklist.md) for related gates.
