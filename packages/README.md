# Shared packages

This directory is reserved for code that is genuinely shared by the API and worker while preserving the boundaries in [the architecture documentation](../docs/architecture/module-boundaries.md).

The runnable-foundation milestone does not add a shared runtime package. The entrypoints currently share no domain or infrastructure behavior that justifies another dependency boundary.
