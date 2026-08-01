# ADR-0014: Webhook endpoint URL and SSRF policy

- **Status:** Accepted
- **Date:** 2026-08-01
- **Decision owners:** SettleFlow Project
- **Reviewers:** Project owner through Webhook Endpoint Foundation approval
- **Supersedes:** None
- **Superseded by:** None

## Context

Merchant-supplied webhook destinations cross an untrusted outbound network boundary. A syntactically valid public URL can resolve to a prohibited address at registration or later change through DNS rebinding. Redirects, alternate IP encodings, IPv4-mapped IPv6 addresses, user information, and nonstandard ports can also bypass incomplete controls.

The specification requires endpoint URL normalization and validation, HTTPS in production, DNS re-resolution immediately before delivery, blocked non-global/reserved targets, restricted egress and ports, and disabled redirects. These controls must be durable policy rather than controller-specific validation. This ADR records repository detail for specification baseline ADR-007 without changing that baseline.

Authoritative references:

- [SettleFlow specification](../specification/SettleFlow_Technical_Product_and_Architecture_Specification_v1.0.docx): FR-09; webhook security; core data model; threat model; specification ADR-007.
- [Architecture overview](../architecture/README.md)
- [Module boundaries](../architecture/module-boundaries.md)
- [Security policy](../../SECURITY.md)
- [ADR-0013](0013-problem-details-audit-and-retention-boundaries.md)

## Decision drivers

- Prevent access to internal, local, metadata, and otherwise prohibited network targets.
- Defend at both registration time and delivery time, including DNS rebinding.
- Keep production policy fail-closed and independent of request-controlled configuration.
- Make URL identity and merchant-scoped uniqueness deterministic.
- Avoid logging destination secrets or sensitive path/query data.
- Permit deliberate local development without weakening production behavior.

## Considered options

### Option A: Layered normalization, resolution, and delivery-time enforcement

Normalize and validate at registration, require every resolved address to satisfy a global-address policy, and repeat resolution and policy enforcement immediately before each future delivery. Pin the validated connection target, prohibit redirects, and restrict production scheme and port. Put any local HTTP allowance behind an explicitly injected development policy.

### Option B: Validate only at registration

This cannot defend against DNS changes or rebinding between registration and delivery. It is rejected.

### Option C: Rely only on an outbound proxy or firewall

Network egress control is required defense in depth, but it does not provide deterministic API validation, normalized uniqueness, or useful client errors. It is rejected as the sole control.

### Option D: Allow environment-sensitive bypasses in the shared validator

Implicit hostname, scheme, or address exceptions can reach production through configuration mistakes. It is rejected.

## Decision

The decision is **Option A**.

### Canonical URL contract

- The Webhooks module owns one URL-policy port used by registration and future delivery. Transport adapters must not implement weaker parallel validation.
- Parse with a standards-conforming URL parser and reject malformed or ambiguous input, credentials/user information, fragments, and unsupported schemes.
- Both the submitted UTF-8 value and its canonical serialized value must be at most **2,048 bytes**. Length is measured in bytes, not JavaScript code units.
- Canonicalization lowercases the scheme and ASCII/IDNA hostname, removes one terminal DNS dot, removes the explicit default port, normalizes an empty path to `/`, and uses the parser's canonical path and percent-encoding. Path and query semantics, including query order and case, are otherwise preserved.
- Production accepts only `https` with effective port **443**. A URL violating that rule is rejected before persistence.
- The canonical value is the normalized URL used for the merchant-wide uniqueness rule in [ADR-0016](0016-webhook-endpoint-api-ownership-and-subscriptions.md). The submitted spelling is not a second source of URL identity.

### Address policy

- Literal IP addresses and every final `A` and `AAAA` result are checked with equivalent IPv4/IPv6 treatment. A hostname is rejected if resolution fails, yields no usable address, or yields even one address that is not allowed.
- Allowed production targets must be globally routable. Reject loopback, private, link-local, unspecified, multicast, carrier-grade NAT, documentation, benchmarking, reserved/future-use, and cloud-metadata destinations, including alternate textual forms and IPv4-mapped IPv6 bypasses.
- DNS lookup is bounded by explicit timeout and answer-count limits and occurs outside the endpoint database transaction. Registration validates the destination but does not make an HTTP probe.
- A prohibited target produces a stable, redacted RFC 9457 problem. Responses and logs must not reveal resolved internal addresses or full destination path/query values.

### Future delivery enforcement

- Immediately before each connection attempt, the delivery adapter must re-resolve the original hostname, validate all returned addresses again, and connect only to an address from that approved result set while preserving the original hostname for TLS SNI and certificate verification.
- Delivery must not follow redirects. Production egress rules and the port-443 restriction are independent defense-in-depth controls.
- A target that becomes prohibited is not contacted. The future delivery state machine records a safe failure and follows its approved retry/terminal policy; this ADR does not authorize outbound delivery or choose that policy.

### Development policy

- HTTP is available only through an explicitly injected development URL-policy adapter. It is fail-closed by default, cannot be selected from a merchant request, and must be rejected when the application runs under the production environment policy.
- Any local-address exception needed by integration tests must also be explicit in that injected adapter and scoped to the intended test target. There is no shared `allowPrivate` or validation-disable switch.

Project-owner approval accepts the canonical URL, production network, re-resolution, and explicit-development-policy decisions above.

## Consequences

### Positive

- Registration and delivery share one reviewable SSRF policy.
- DNS rebinding and mixed public/private answer sets fail closed.
- URL uniqueness is deterministic within each merchant.
- Local testing remains possible without a production bypass.

### Negative

- Registration depends on bounded DNS resolution and can fail during resolver outages.
- Some syntactically valid destinations are intentionally unsupported in production.
- Delivery requires controlled address pinning and TLS hostname handling rather than a default redirect-following HTTP client.

### Risks and mitigations

- **Parser/normalizer drift:** Persist the canonical value, version the policy only through reviewed compatibility work, and use a fixed corpus of equivalence/bypass cases.
- **DNS time-of-check/time-of-use race:** Resolve immediately before connecting and pin the connection to an approved answer.
- **IPv6 or unusual notation bypass:** Normalize and test IPv4, IPv6, mapped-address, integer, octal-like, and encoded-host inputs through one policy.
- **Production development-policy activation:** Bind policy by trusted deployment configuration and fail startup when a development adapter is selected in production.
- **Sensitive URL leakage:** Redact path/query and resolved prohibited addresses from problems, logs, traces, and audit data.

## Implementation notes

- The exact URL/DNS library and outbound HTTP adapter are selected in a later approved implementation plan after dependency review.
- URL policy evaluation must be injectable so unit/integration tests do not depend on uncontrolled public DNS.
- URL changes are not supported. A merchant registers a different endpoint and disables the old endpoint.
- This ADR milestone creates no endpoint, DNS, HTTP, database, or delivery implementation.

## Affected requirements and invariants

- **Requirements:** FR-09 webhook endpoint management and SSRF controls; FR-13 safe errors and correlation.
- **Invariants:** No financial invariant changes. Merchant ownership and secret/logging boundaries remain mandatory.
- **Acceptance:** Normalization corpus, DNS-rebinding, mixed-answer, prohibited-range, redirect, TLS/SNI, policy-injection, and redaction tests are required when implemented.

## Impact assessment

- **Affected modules and dependency direction:** Webhooks owns the policy; API and future worker adapters call Webhooks ports.
- **Financial invariants and money representation:** None.
- **Database schema, migration, locking, and transaction boundaries:** Future endpoints persist one canonical URL; DNS/network work stays outside database transactions.
- **Idempotency, outbox/inbox, retries, and partial failure:** Future delivery retries must re-run the address policy before every attempt.
- **API, event, webhook, or CSV compatibility:** Establishes accepted URL input and production destination compatibility.
- **Authentication, authorization, secrets, SSRF, and sensitive data:** Directly defines the webhook SSRF boundary and URL redaction.
- **Observability, alerting, and runbooks:** Record stable policy failure classes without raw sensitive values; document DNS/egress diagnosis.
- **Production dependencies and supply-chain impact:** Exact parser, resolver, and HTTP adapter remain implementation-plan decisions.

## Verification

- Test canonical-equivalence and merchant-scoped uniqueness inputs, byte limits, malformed values, user information, fragments, schemes, and ports.
- Test every prohibited IPv4/IPv6 category, mapped forms, mixed DNS results, empty/time-out results, and re-resolution changes.
- Prove the production policy cannot load the development adapter and that local exceptions are explicit and target-scoped.
- Prove redirects are disabled and future delivery connects only to the validated address while verifying TLS against the original hostname.
- Scan RFC 9457 problems, logs, traces, and audit records for URL path/query and resolved-address leakage.

## Rollout and recovery

Implement and test the policy before enabling endpoint registration. Future delivery must reuse it before any external request. If the policy has a defect, disable registration/delivery and forward-fix it; do not introduce a broad bypass. Re-evaluate stored normalized URLs under a versioned migration plan before changing canonicalization semantics.

## Documentation and traceability

The [ADR index](README.md) records acceptance. Future Webhook Endpoint and delivery plans, OpenAPI, security guidance, configuration documentation, tests, and incident runbooks must cite this ADR.
