# OfficePulseAidaIntegration — non-root container image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/write-build-info.mjs ./scripts/
ARG BUILD_REVISION
ARG SOURCE_DATE_EPOCH
ARG BUILD_DIRTY
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY deploy/sql/runtime-schema.sql deploy/sql/002_device_access.sql deploy/sql/003_event_receipts.sql deploy/sql/004_remove_retired_pbx.sql deploy/sql/005_agent_admission.sql deploy/sql/006_call_scope.sql deploy/sql/007_handset_devices.sql ./deploy/sql/
# Run as the unprivileged 'node' user; ports are >1024 so no capabilities
# are needed.
USER node
EXPOSE 4573 8085 8086 8087
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8085)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
