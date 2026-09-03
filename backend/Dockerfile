# PocketBase for Render (or any Docker host).
# Render injects $PORT and expects the process to bind it.
#
# Persistence:
#   - Paid instance: mount a disk at /pb/pb_data (see render.yaml).
#   - Free instance: set LITESTREAM_* env vars to replicate to object storage.
#   - Neither: runs fine, but the SQLite file is lost on restart/redeploy.

FROM alpine:3.20

ARG PB_VERSION=0.28.4
ARG LITESTREAM_VERSION=0.3.13

RUN apk add --no-cache ca-certificates unzip wget

WORKDIR /pb

RUN wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip" \
  && unzip "pocketbase_${PB_VERSION}_linux_amd64.zip" \
  && rm "pocketbase_${PB_VERSION}_linux_amd64.zip"

RUN wget -q "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
  && tar -C /usr/local/bin -xzf "litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
  && rm "litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz"

# Schema migration + retention hook. Baked in so a fresh deploy / fresh disk
# provisions the collections on first boot.
COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
COPY pb_public /pb/pb_public
COPY entrypoint.sh /pb/entrypoint.sh
RUN chmod +x /pb/entrypoint.sh

EXPOSE 8080

CMD ["/pb/entrypoint.sh"]
