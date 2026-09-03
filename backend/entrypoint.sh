#!/bin/sh
set -e

DATA_DIR="/pb/pb_data"
DB_FILE="${DATA_DIR}/data.db"
LS_CONFIG="/etc/litestream.yml"
PB="/pb/pocketbase serve --http=0.0.0.0:${PORT:-8080} --dir=${DATA_DIR} --migrationsDir=/pb/pb_migrations --hooksDir=/pb/pb_hooks --publicDir=/pb/pb_public"

mkdir -p "${DATA_DIR}"

bootstrap_superuser() {
  if [ -n "${PB_SUPERUSER_EMAIL}" ] && [ -n "${PB_SUPERUSER_PASSWORD}" ]; then
    /pb/pocketbase superuser upsert "${PB_SUPERUSER_EMAIL}" "${PB_SUPERUSER_PASSWORD}" --dir="${DATA_DIR}" || true
  fi
}

# --- Litestream (optional) ------------------------------------------------
# Set these env vars to make an ephemeral (free-tier) filesystem durable:
#   LITESTREAM_BUCKET, LITESTREAM_ENDPOINT, LITESTREAM_ACCESS_KEY_ID,
#   LITESTREAM_SECRET_ACCESS_KEY   (works with Cloudflare R2, Backblaze B2, S3)
if [ -n "${LITESTREAM_BUCKET}" ] && [ -n "${LITESTREAM_ACCESS_KEY_ID}" ]; then
  echo "[entrypoint] Litestream enabled -> bucket=${LITESTREAM_BUCKET}"

  cat > "${LS_CONFIG}" <<EOF
dbs:
  - path: ${DB_FILE}
    replicas:
      - type: s3
        bucket: ${LITESTREAM_BUCKET}
        path: ${LITESTREAM_PATH:-pocketbase}
        endpoint: ${LITESTREAM_ENDPOINT}
        access-key-id: ${LITESTREAM_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_SECRET_ACCESS_KEY}
        force-path-style: true
EOF

  if [ ! -f "${DB_FILE}" ]; then
    echo "[entrypoint] restoring database from replica (if one exists)..."
    litestream restore -config "${LS_CONFIG}" -if-replica-exists -o "${DB_FILE}" "${DB_FILE}" || true
  fi

  bootstrap_superuser
  exec litestream replicate -config "${LS_CONFIG}" -exec "${PB}"
fi

# --- plain PocketBase (NO persistence guarantee on free tier) ------------
bootstrap_superuser
exec ${PB}
