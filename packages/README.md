# Shared packages

This directory contains code genuinely shared by the API and worker while preserving the boundaries in [the architecture documentation](../docs/architecture/module-boundaries.md).

`infrastructure` owns health-only PostgreSQL and RabbitMQ connection lifecycle shared by both entrypoints. It exposes bounded probes and clean shutdown only; it does not own schema, migrations, Prisma access, queue topology, publishing, consumption, or domain behavior.
