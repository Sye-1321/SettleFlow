# Shared packages

This directory contains shared infrastructure and bounded-domain packages while preserving the boundaries in [the architecture documentation](../docs/architecture/module-boundaries.md).

`infrastructure` owns PostgreSQL and RabbitMQ connection lifecycle shared by both entrypoints. It exposes bounded readiness probes, one lazy Prisma client per process, and clean shutdown. Prisma schema and migration history remain at the workspace root; future persistence adapters must stay inside their owning domain modules and may share this client instead of bypassing module boundaries. The package does not own an application model, queue topology, publishing, consumption, or domain behavior.

`modules/merchant-access` owns the specification-authorized merchant/API-key types, credential lifecycle, application service, and Prisma persistence adapter. The API composes it; the worker does not depend on it. No other module may write its tables directly in production code.

`modules/idempotency` owns command-key hashing, merchant/method/route scoping, request fingerprints, leases, single-winner acquisition, and bounded response snapshots. Its reviewed Prisma adapter is the only production writer of `idempotency_keys`.

`modules/eventing` owns the approved event contract, transactional persistence of `outbox_events`, PostgreSQL lease/claim/finalization behavior, and RabbitMQ confirm publisher/topology. The worker composes its public relay surface. Eventing publishes at least once but owns no consumer, inbox, webhook effect, or financial state.

`modules/payments` owns the M1 Payment Intent command/query service, validation, representation, and Prisma adapter. It can request Idempotency and Eventing application operations but cannot write their tables directly. It exposes only create/read behavior in this milestone; later lifecycle and financial domains remain deferred.

`modules/operations` owns the append-only lifecycle-audit vocabulary and transaction-aware persistence port. Its Prisma adapter may insert bounded audit evidence inside an owning domain's transaction, but application code cannot update or delete audit rows.

`modules/webhooks` owns merchant-scoped endpoint, subscription, encrypted-secret, URL-policy, and lifecycle application behavior. It depends on the Operations audit port for atomic evidence. It does not deliver HTTP webhooks, consume RabbitMQ messages, or own payment state.
