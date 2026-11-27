# syntax=docker/dockerfile:1.19

FROM --platform=$BUILDPLATFORM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS build

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown
ARG DIRTY=true
ARG RELEASE_FAMILY=neocloud

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOBIN=/tmp/license-tools go install github.com/google/go-licenses/v2@v2.0.1
COPY . .
RUN case "$RELEASE_FAMILY" in \
    neocloud) ;; \
    clouddrive) sed -i 's#^module github.com/reina0721/neocloud$#module github.com/reina0721/clouddrive#' go.mod \
      && find cmd internal pkg -name '*.go' -type f -exec sed -i 's#"github.com/reina0721/neocloud/#"github.com/reina0721/clouddrive/#g' {} + ;; \
    *) exit 1 ;; esac
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -buildvcs=false \
    -ldflags="-s -w -X main.buildVersion=${VERSION} -X main.buildCommit=${COMMIT} -X main.buildTime=${BUILD_TIME} -X main.buildDirty=${DIRTY}" \
    -o /out/application ./cmd/app
RUN mkdir -p /out/runtime/.data && chmod 0700 /out/runtime/.data
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} /tmp/license-tools/go-licenses save ./cmd/app --save_path=/out/third-party \
    && cp /usr/local/go/LICENSE /out/third-party/GO-LICENSE

FROM gcr.io/distroless/static-debian13:nonroot@sha256:b5b9fd04c8dcf72a173183c0b7dee47e053e002246b308a59f3441db7b8b9cc4 AS runtime

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown
ARG SOURCE=https://github.com/reina0721/neocloud
ARG RELEASE_FAMILY=neocloud

LABEL org.opencontainers.image.title="${RELEASE_FAMILY}" \
      org.opencontainers.image.description="NeoCloud file management and collaboration API" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
COPY --chown=nonroot:nonroot LICENSE NOTICE SOURCES.json /usr/share/licenses/${RELEASE_FAMILY}/
COPY --chown=nonroot:nonroot --from=build /out/third-party/ /usr/share/licenses/${RELEASE_FAMILY}/third-party/
COPY --chown=nonroot:nonroot config.example.yaml /app/config.yaml
COPY --chown=nonroot:nonroot locales/ /app/locales/
COPY --chown=nonroot:nonroot internal/module/todo/binding/i18n/locales/ /app/internal/module/todo/binding/i18n/locales/
COPY --chown=nonroot:nonroot --from=build /out/runtime/ /app/

USER nonroot:nonroot
EXPOSE 8080 9090

FROM runtime AS clouddrive
COPY --chown=nonroot:nonroot --from=build /out/application /app/clouddrive
ENTRYPOINT ["/app/clouddrive"]

FROM runtime AS neocloud
COPY --chown=nonroot:nonroot --from=build /out/application /app/neocloud
ENTRYPOINT ["/app/neocloud"]
