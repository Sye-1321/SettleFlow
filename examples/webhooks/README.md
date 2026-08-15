# Synthetic Webhook Receiver

The reviewer demo uses [`tools/demo/webhook-receiver.mjs`](../../tools/demo/webhook-receiver.mjs) as an in-process example consumer inside a hardened demo-only sidecar. It verifies the exact received bytes, five-minute timestamp recency, delivery and event identifiers, schema/event metadata, and HMAC-SHA-256 signature before acknowledging.

For the demo's first valid delivery it returns one deterministic `503`; the existing persisted delivery scheduler retries without policy changes, and the receiver then returns `204`. It retains only bounded hashes and identifiers in process memory for assertions and never prints or writes the Webhook body, secret, or signature.
