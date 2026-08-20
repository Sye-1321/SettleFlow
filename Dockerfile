# syntax=docker/dockerfile:1.7

ARG NODE_BUILD_IMAGE=node:24.18.0-trixie@sha256:eb2c73a27cf714b4b6b030f88ab72e62192c38b7d313ea3456695b8ae03c5f3c
ARG NODE_IMAGE=node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/base-nossl-debian13@sha256:86554c46a420d507ff2d678fd261ab8691fba4875a20302f38a49e684b42a33f

FROM ${NODE_BUILD_IMAGE} AS openssl-runtime-build
ARG OPENSSL_VERSION=3.5.7
ARG OPENSSL_SOURCE_SHA256=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8
WORKDIR /build
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" \
      --output openssl.tar.gz && \
    printf '%s  %s\n' "${OPENSSL_SOURCE_SHA256}" openssl.tar.gz > openssl.sha256 && \
    sha256sum --check openssl.sha256 && \
    mkdir openssl-source && \
    tar --extract --gzip --file openssl.tar.gz --directory openssl-source --strip-components=1
WORKDIR /build/openssl-source
RUN ./config \
      --prefix=/opt/settleflow-openssl \
      --libdir=lib \
      shared \
      no-apps \
      no-docs \
      no-quic \
      no-tests
RUN make -j1 && \
    make install_sw
RUN grep --fixed-strings '#  define OPENSSL_NO_QUIC' \
      /opt/settleflow-openssl/include/openssl/configuration.h

FROM ${NODE_IMAGE} AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /workspace
RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
      libssl3t64=3.5.6-1~deb13u2 \
      openssl=3.5.6-1~deb13u2 && \
    rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
RUN node -e \
      "if(process.versions.node!=='24.18.0'||process.versions.openssl!=='3.5.7')process.exit(1);try{require('node:quic');process.exit(1)}catch(error){if(error.code!=='ERR_UNKNOWN_BUILTIN_MODULE')throw error}"
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

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ENV HOME=/tmp
ENV NODE_ENV=development
ENV XDG_CACHE_HOME=/tmp/.cache
COPY --from=toolchain /usr/local/bin/node /nodejs/bin/node
COPY --from=openssl-runtime-build /opt/settleflow-openssl/lib/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
COPY --from=openssl-runtime-build /opt/settleflow-openssl/lib/libssl.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=toolchain /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 /usr/lib/x86_64-linux-gnu/libgcc_s.so.1
COPY --from=toolchain /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
WORKDIR /app
STOPSIGNAL SIGTERM
USER 10001:10001

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
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(String(r.status))}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
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
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:9465/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error(String(r.status))}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
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
COPY --chown=10001:10001 tools/operations/verify-restored-database.mjs ./tools/operations/
USER 10001:10001
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["tools/release/run-migrations.mjs"]
