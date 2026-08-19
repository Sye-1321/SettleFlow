# Webhook Endpoint API

The Webhook Endpoint boundary lets an authenticated merchant register and manage destinations used by the implemented RabbitMQ projection and signed HTTP delivery worker. Eligibility uses the endpoint state present when an event is projected: active and subscribed endpoints receive a delivery record, and later subscription changes never cause historical fanout.

## Authentication and scopes

All routes require `Authorization: Bearer <merchant_api_key>`. Reads require `webhooks:read`; mutations require `webhooks:manage`. Every repository predicate includes the authenticated merchant ID, so an endpoint owned by another merchant is indistinguishable from a missing endpoint.

| Method  | Path                                          | Scope             | Purpose                                       |
| ------- | --------------------------------------------- | ----------------- | --------------------------------------------- |
| `POST`  | `/v1/webhook-endpoints`                       | `webhooks:manage` | Create an endpoint and reveal its secret once |
| `GET`   | `/v1/webhook-endpoints`                       | `webhooks:read`   | List endpoints with keyset pagination         |
| `GET`   | `/v1/webhook-endpoints/{id}`                  | `webhooks:read`   | Read one endpoint                             |
| `PATCH` | `/v1/webhook-endpoints/{id}`                  | `webhooks:manage` | Change status and/or subscriptions            |
| `POST`  | `/v1/webhook-endpoints/{id}/secret-rotations` | `webhooks:manage` | Rotate the signing secret                     |

The machine-readable contract is [openapi.json](openapi.json).

## Create and one-time secret disclosure

Create accepts only a URL and a nonempty subscription set. The supported events are `payment.created.v1`, `payment.captured.v1`, `payment.refunded.v1`, `settlement.finalized.v1`, and `reconciliation.completed.v1`. Subscription changes affect only events projected after the change; they never cause historical fanout.

```json
{
  "url": "https://merchant.example/webhooks/settleflow",
  "subscriptions": [
    "payment.created.v1",
    "payment.captured.v1",
    "payment.refunded.v1",
    "settlement.finalized.v1",
    "reconciliation.completed.v1"
  ]
}
```

A successful `201` response contains endpoint metadata and a `whsec_` secret backed by 32 random bytes. The secret is returned only in that response and cannot be recovered. PostgreSQL stores only AES-256-GCM ciphertext, nonce, tag, key ID, lifecycle metadata, and timestamps. The response includes `Cache-Control: no-store`, `X-Request-Id`, and a strong ETag such as `"whe_01ARZ3NDEKTSV4RRFFQ69G5FAV.v0"`.

The URL is immutable after creation. URLs are normalized before persistence and unique per merchant across active and inactive endpoints. Production policy accepts only HTTPS on port 443 and destinations whose DNS answers are all global, non-reserved addresses. Development HTTP requires an exact origin in the explicitly configured development allowlist. See the [security policy](../../SECURITY.md) for the complete boundary.

## Read and pagination

Read responses never contain a secret or encrypted-secret metadata. List ordering is descending by public endpoint ID. `limit` defaults to 20 and is bounded from 1 through 100. When another page exists, `nextCursor` contains an opaque base64url keyset cursor; clients must return it unchanged as `cursor` and must not decode or construct cursors.

```text
GET /v1/webhook-endpoints?limit=20&cursor=<opaque-cursor>
```

## Conditional changes

PATCH accepts `status`, `subscriptions`, or both and requires exactly one strong `If-Match` header containing the endpoint's current ETag. Missing preconditions return `428`; malformed or stale preconditions return `412` without mutation. A semantic no-op returns `200` with the same version and creates no audit record. A real change increments the version once. If both status and subscriptions change, the transaction appends two correlated lifecycle audit records.

```json
{
  "status": "inactive",
  "subscriptions": ["payment.captured.v1", "payment.refunded.v1"]
}
```

Secret rotation also requires the current ETag and an empty body. It is allowed while the endpoint is inactive. Success returns the new secret once, increments the endpoint version, and retains the previous encrypted secret for exactly 24 hours. The previous secret is never returned. Delivery signs with the current secret first and the eligible previous secret second during that overlap; deletion or cleanup is not implemented.

## Error contract

Errors use `application/problem+json` with RFC 9457 fields and a stable SettleFlow `code`. Authentication failures are generic. Ownership failures use the same `404` as missing resources. Request bodies reject unknown fields, unsupported subscription events, invalid status values, malformed identifiers, and invalid or prohibited URLs.

| Status | Representative code             | Meaning                                          |
| ------ | ------------------------------- | ------------------------------------------------ |
| 400    | `invalid_request`               | Malformed ID, body, query, cursor, or header     |
| 401    | `authentication_required`       | Merchant credential missing or invalid           |
| 403    | `insufficient_scope`            | Credential lacks the route's required scope      |
| 404    | `webhook_endpoint_not_found`    | Endpoint absent or owned by another merchant     |
| 409    | `webhook_endpoint_url_conflict` | Normalized URL already exists for this merchant  |
| 412    | `precondition_failed`           | A well-formed endpoint If-Match value is stale   |
| 422    | `validation_failed`             | URL prohibited/unresolvable or event unsupported |
| 428    | `precondition_required`         | If-Match is missing                              |
| 503    | `service_unavailable`           | Database, DNS, or keyring dependency unavailable |

Responses and logs never expose signing secrets, encryption material, raw DNS errors, database details, or another merchant's existence.

## Local configuration

The checked-in example uses the local keyring only for development. Generate a 32-byte base64url key, put it only in the ignored `apps/api/.env`, and keep the key ID consistent with the JSON map:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```dotenv
WEBHOOK_KEYRING_PROVIDER=local
WEBHOOK_LOCAL_ACTIVE_KEY_ID=local-v1
WEBHOOK_LOCAL_KEYS_JSON={"local-v1":"<generated-base64url-key>"}
WEBHOOK_URL_POLICY_MODE=development
WEBHOOK_DEVELOPMENT_ALLOWED_ORIGINS=["http://127.0.0.1:8080"]
```

The API refuses to start with the local provider or development URL policy in production. A production KMS/keyring adapter and outbound delivery controls remain deferred.
