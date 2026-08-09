# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_IMAGE} AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /workspace
RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
      libssl3=3.0.20-1~deb12u2 \
      openssl=3.0.20-1~deb12u2 && \
    rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile --prefer-offline --network-concurrency=4 --fetch-retries=5 --fetch-retry-maxtimeout=120000

FROM toolchain AS build
RUN pnpm build

FROM build AS deploy
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm \
    pnpm --filter @settleflow/api --prod deploy --legacy --prefer-offline --network-concurrency=4 --fetch-retries=5 --fetch-retry-maxtimeout=120000 /opt/settleflow-api && \
    pnpm --filter @settleflow/worker --prod deploy --legacy --prefer-offline --network-concurrency=4 --fetch-retries=5 --fetch-retry-maxtimeout=120000 /opt/settleflow-worker && \
    pnpm --filter @settleflow/migrator --prod deploy --legacy --prefer-offline --network-concurrency=4 --fetch-retries=5 --fetch-retry-maxtimeout=120000 /opt/settleflow-migrator && \
    install --mode=0755 \
      /workspace/node_modules/.pnpm/@prisma+engines@7.9.1/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x \
      /opt/settleflow-migrator/node_modules/.pnpm/@prisma+engines@7.9.1/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x && \
    find /opt/settleflow-api /opt/settleflow-worker -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
      libssl3=3.0.20-1~deb12u2 \
      openssl=3.0.20-1~deb12u2 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 settleflow && \
    useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin settleflow
ENV HOME=/tmp
ENV NODE_ENV=development
ENV XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
STOPSIGNAL SIGTERM

FROM runtime AS api
ARG OCI_CREATED=unknown
ARG OCI_REVISION=unknown
ARG OCI_VERSION=0.0.0-sim
LABEL org.opencontainers.image.created=${OCI_CREATED} \
      org.opencontainers.image.description="SettleFlow finance-grade simulation API" \
      org.opencontainers.image.revision=${OCI_REVISION} \
      org.opencontainers.image.source="https://github.com/Sye-1321/SettleFlow" \
      org.opencontainers.image.title="SettleFlow API" \
      org.opencontainers.image.version=${OCI_VERSION}
COPY --from=deploy --chown=10001:10001 /opt/settleflow-api/ ./
USER 10001:10001
EXPOSE 3000 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(String(r.status))}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node"]
CMD ["dist/main.js"]

FROM runtime AS worker
ARG OCI_CREATED=unknown
ARG OCI_REVISION=unknown
ARG OCI_VERSION=0.0.0-sim
LABEL org.opencontainers.image.created=${OCI_CREATED} \
      org.opencontainers.image.description="SettleFlow finance-grade simulation worker" \
      org.opencontainers.image.revision=${OCI_REVISION} \
      org.opencontainers.image.source="https://github.com/Sye-1321/SettleFlow" \
      org.opencontainers.image.title="SettleFlow Worker" \
      org.opencontainers.image.version=${OCI_VERSION}
COPY --from=deploy --chown=10001:10001 /opt/settleflow-worker/ ./
USER 10001:10001
EXPOSE 9465
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9465/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(String(r.status))}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node"]
CMD ["dist/main.js"]

FROM runtime AS migrator
ARG OCI_CREATED=unknown
ARG OCI_REVISION=unknown
ARG OCI_VERSION=0.0.0-sim
LABEL org.opencontainers.image.created=${OCI_CREATED} \
      org.opencontainers.image.description="SettleFlow one-shot schema migrator and verifier" \
      org.opencontainers.image.revision=${OCI_REVISION} \
      org.opencontainers.image.source="https://github.com/Sye-1321/SettleFlow" \
      org.opencontainers.image.title="SettleFlow Migrator" \
      org.opencontainers.image.version=${OCI_VERSION}
COPY --from=deploy --chown=10001:10001 /opt/settleflow-migrator/ ./
COPY --chown=10001:10001 prisma ./prisma
COPY --chown=10001:10001 prisma.config.mts ./prisma.config.mts
COPY --chown=10001:10001 tools/release/run-migrations.mjs tools/release/verify-release-database.mjs ./tools/release/
USER 10001:10001
ENTRYPOINT ["node"]
CMD ["tools/release/run-migrations.mjs"]
