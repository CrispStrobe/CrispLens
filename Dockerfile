# =============================================================================
# CrispLens — multi-stage Dockerfile
#
# Build:
#   docker build -t crisp-lens .
#
# Run (admin account created on first start):
#   docker run -d \
#     -p 7865:7865 \
#     -v crisp-data:/data \
#     -e FACE_REC_DATA_DIR=/data \
#     -e CRISP_ADMIN_USER=admin \
#     -e CRISP_ADMIN_PASS=changeme \
#     --name crisp-lens \
#     crisp-lens
#
# Runtime environment variables:
#   FACE_REC_PORT         listen port                (default: 7865)
#   FACE_REC_DATA_DIR     data directory             (default: /data)
#   FACE_REC_WORKERS      uvicorn worker count       (default: 1)
#   FACE_REC_DB_PATH      absolute DB path           (optional override)
#   FACE_REC_LOG_LEVEL    log verbosity              (default: info)
#   CRISP_ADMIN_USER      bootstrap admin username   (first start only)
#   CRISP_ADMIN_PASS      bootstrap admin password   (first start only)
# =============================================================================

# ── Stage 1: build Svelte frontend ───────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build/electron-app-v2/renderer
COPY electron-app-v2/renderer/package*.json ./
RUN npm ci --prefer-offline --loglevel=error

COPY electron-app-v2/renderer/ ./
RUN npm run build


# ── Stage 2: Python runtime ───────────────────────────────────────────────────
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System dependencies
RUN apt-get update -qq && apt-get install -y -qq \
    python3 python3-pip python3-venv python3-dev \
    python3-yaml sqlite3 build-essential curl rsync \
    libssl-dev libffi-dev libgl1 libglib2.0-0 exiftool \
    && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app

# Python venv + dependencies
COPY requirements.txt .
RUN python3 -m venv /app/venv \
    && /app/venv/bin/pip install --upgrade pip -q \
    && /app/venv/bin/pip install -q -r requirements.txt \
    && /app/venv/bin/pip install -q imagehash || true

# Copy application source
COPY *.py ./
COPY routers/ ./routers/
COPY i18n* ./
COPY config.example.yaml ./
COPY schema_complete.sql ./
COPY electron-app-v2/renderer/dist/ ./electron-app-v2/renderer/dist/

# Bring in the built frontend from stage 1
COPY --from=frontend-builder /build/electron-app-v2/renderer/dist/ \
     ./electron-app-v2/renderer/dist/

# Patch config for Linux (no CoreML, lazy model init)
RUN if [ -f config.example.yaml ]; then \
    cp config.example.yaml config.yaml; \
    python3 -c "\
import yaml; \
f='config.yaml'; \
d=yaml.safe_load(open(f)) or {}; \
d.setdefault('face_recognition',{}).setdefault('insightface',{})['use_coreml']=False; \
d['face_recognition']['lazy_init']=True; \
yaml.dump(d, open(f,'w'), default_flow_style=False, allow_unicode=True)"; \
fi

# Container entrypoint
COPY <<'EOF' /app/start.sh
#!/usr/bin/env bash
set -e
: "${FACE_REC_PORT:=7865}"
: "${FACE_REC_DATA_DIR:=/data}"
: "${FACE_REC_WORKERS:=1}"
: "${FACE_REC_LOG_LEVEL:=info}"
mkdir -p "$FACE_REC_DATA_DIR"
export FACE_REC_DATA_DIR
exec /app/venv/bin/uvicorn fastapi_app:app \
    --host 0.0.0.0 \
    --port  "$FACE_REC_PORT" \
    --workers "$FACE_REC_WORKERS" \
    --log-level "$FACE_REC_LOG_LEVEL"
EOF
RUN chmod +x /app/start.sh

# Data volume — mount a host directory or named volume here
VOLUME ["/data"]

EXPOSE 7865

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:${FACE_REC_PORT:-7865}/api/health || exit 1

ENTRYPOINT ["/app/start.sh"]
