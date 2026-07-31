# Merchant Access API and security

Merchant Access is the specification-authorized machine-identity boundary for merchant backends. It owns only `merchants`, their `api_keys`, and the exact scope vocabulary below. It is separate from operator identity and does not provide user accounts, passwords, JWTs, sessions, RBAC, or merchant self-service onboarding.

## HTTP contract

| Route                    | Authentication                             | Purpose                           |
| ------------------------ | ------------------------------------------ | --------------------------------- |
| `GET /health/live`       | Public                                     | Process liveness only             |
| `GET /health/ready`      | Public                                     | PostgreSQL and RabbitMQ readiness |
| `GET /api/v1`            | `Authorization: Bearer <merchant_api_key>` | Authenticated version entrypoint  |
| `GET /docs`              | Public                                     | Swagger UI                        |
| `GET /docs/openapi.json` | Public                                     | Runtime OpenAPI JSON              |

The committed machine-readable contract is [openapi.json](openapi.json). Generate it with `pnpm openapi:generate` and detect drift with `pnpm openapi:check`.

Missing, malformed, unknown, disabled, revoked, rotated, wrong-secret, or disabled-merchant credentials receive the same generic HTTP 401 response. A valid credential without every scope declared by a future handler receives HTTP 403. Health and documentation routes are the only explicit public surfaces.

No merchant or API-key lifecycle HTTP endpoint exists. Issuance, disablement, revocation, and rotation are bounded-domain application-service operations only until a separately authorized operator authentication and audit milestone exists.

## Credential handling

- The one-time credential is `sf_test_<public>.<secret>`, with a 72-bit public lookup component and an independent 256-bit secret.
- Only the `sf_test_<public>` prefix and a versioned salted scrypt hash are persisted.
- The plaintext is returned only by a successful issue or rotation call and cannot be recovered later.
- Authentication first applies the active-key, non-revoked, active-merchant database predicate, then verifies the slow hash with a constant-time digest comparison.
- Rotation atomically revokes the old key and creates one replacement, with no overlap window. Concurrent rotations have one winner.
- Request identity contains only merchant ID, API-key ID, and granted scopes. It never contains a credential, hash, or full merchant record.

Never commit, log, document, screenshot, or place a usable credential in shell history. The repository has no deterministic API-key seed.

## Exact scope vocabulary

- `payments:write`
- `payments:read`
- `ledger:read`
- `webhooks:manage`
- `webhooks:read`
- `settlements:write`
- `settlements:read`
- `reconciliation:write`
- `reconciliation:read`

There is no wildcard or mutable scope table. These strings authorize no financial behavior in the current milestone; they establish only the specification-defined credential vocabulary for later bounded modules.

## Verification commands

```shell
pnpm prisma:validate
pnpm prisma:generate
pnpm db:migrate:apply
pnpm db:migrate:status
pnpm test:merchant-access
pnpm test:integration
pnpm openapi:check
```

Integration tests create disposable synthetic merchants and keys in Testcontainers PostgreSQL, prove hash-at-rest and tenant identity, exercise authentication success/failure/disable/revoke/rotate, and destroy the environment after the suite.
