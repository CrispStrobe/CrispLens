# =============================================================================
# CrispLens v4 — multi-stage Dockerfile (Node.js API + Svelte UI)
# Supports: Hugging Face Spaces, VPS, and local Docker.
# =============================================================================

# ── Stage 1: Build Svelte Frontend ───────────────────────────────────────────
FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /build
COPY electron-app-v4/renderer/package*.json ./electron-app-v4/renderer/
RUN cd electron-app-v4/renderer && npm install

COPY electron-app-v4/renderer/ ./electron-app-v4/renderer/
RUN cd electron-app-v4/renderer && npm run build

# ── Stage 2: Node.js Runtime ──────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=7860 \
    DB_PATH=/data/face_recognition.db \
    FACE_REC_MODELS_DIR=/app/models

# Install system dependencies for native modules (better-sqlite3, sharp)
# and utilities (sqlite3, curl, exiftool)
RUN apt-get update -qq && apt-get install -y -qq \
    python3 make g++ \
    sqlite3 curl libvips-dev exiftool \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy backend dependencies first for caching
COPY electron-app-v4/package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY electron-app-v4/server.js ./
COPY electron-app-v4/electron-main.js ./
COPY electron-app-v4/preload.js ./
COPY electron-app-v4/server/ ./server/
COPY electron-app-v4/core/ ./core/
COPY electron-app-v4/assets/ ./assets/
# Ensure schema is available for DB init
COPY schema_complete.sql ./

# Copy built frontend from Stage 1
COPY --from=frontend-builder /build/electron-app-v4/renderer/dist/ ./renderer/dist/

# Pre-download models during build into /app/models/buffalo_l/.
# --accept-nc accepts InsightFace's non-commercial research license for the
# buffalo_l model on behalf of the image (the image ships these models;
# downstream users of this image are responsible for their own licence
# compliance per the notice in README / app UI).
RUN node core/model-downloader.js --accept-nc

# Create data directory and set permissions for Hugging Face user (1000)
RUN mkdir -p /data && chown -R 1000:1000 /app /data
USER 1000

# Container entrypoint script
COPY --chown=1000:1000 <<'EOF' /app/start.sh
#!/usr/bin/env bash
set -e

# Initialize DB if missing
if [ ! -f "$DB_PATH" ]; then
    echo "[init] Creating fresh database at $DB_PATH..."
    mkdir -p "$(dirname "$DB_PATH")"
    sqlite3 "$DB_PATH" < schema_complete.sql
    echo "[init] Database initialized."
fi

# Start Node.js server
# Hugging Face provides PORT=7860 env var by default
echo "[start] Launching CrispLens v4 Node.js API on port ${PORT:-7860}..."
exec node server.js "${PORT:-7860}" "$DB_PATH"
EOF

RUN chmod +x /app/start.sh

# Data volume — mount a host directory or HF Dataset here
VOLUME ["/data"]

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:${PORT:-7860}/api/health || exit 1

ENTRYPOINT ["/app/start.sh"]
