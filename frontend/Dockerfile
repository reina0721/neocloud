FROM node:24-bookworm AS build
ENV NEXT_PUBLIC_AUTH_MODE=backend
ENV NEXT_PUBLIC_AUTH_API_BASE_URL=/api/console/v1
ENV WEB_DEPLOYMENT_MODE=server
WORKDIR /app/frontend
COPY frontend/ ./
RUN mkdir -p /app/api \
    && npx --yes pnpm@10.22.0 install --frozen-lockfile \
    && npx --yes pnpm@10.22.0 build \
    && npx --yes pnpm@10.22.0 standalone:check

FROM node:24-bookworm-slim AS runtime
ARG VERSION=dev
ARG COMMIT=unknown
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.source="https://github.com/reina0721/neocloud" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV CLOUDDRIVE_BACKEND_URL=http://backend:8080
ENV HOSTNAME=0.0.0.0
ENV PORT=4173
WORKDIR /app
COPY --chown=node:node LICENSE NOTICE SOURCES.json /usr/share/licenses/clouddrive/
COPY --chown=node:node frontend/apps/web/public/fonts/licenses/ /usr/share/licenses/clouddrive/fonts/
COPY --from=build --chown=node:node /app/frontend/apps/web/dist/standalone/ ./
COPY --from=build --chown=node:node /app/frontend/apps/web/dist/standalone/licenses/ /usr/share/licenses/clouddrive/third-party/
WORKDIR /app/apps/web
USER node
EXPOSE 4173
CMD ["node", "server.js"]
