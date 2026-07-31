# Shared packages

This directory contains shared infrastructure and bounded-domain packages while preserving the boundaries in [the architecture documentation](../docs/architecture/module-boundaries.md).

`infrastructure` owns PostgreSQL and RabbitMQ connection lifecycle shared by both entrypoints. It exposes bounded readiness probes, one lazy Prisma client per process, and clean shutdown. Prisma schema and migration history remain at the workspace root; future persistence adapters must stay inside their owning domain modules and may share this client instead of bypassing module boundaries. The package does not own an application model, queue topology, publishing, consumption, or domain behavior.

`modules/merchant-access` owns the specification-authorized merchant/API-key types, credential lifecycle, application service, and Prisma persistence adapter. The API composes it; the worker does not depend on it. No other module may write its tables directly in production code.
