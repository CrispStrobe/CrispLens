#!/usr/bin/env bash
# =============================================================================
# deploy-v2.sh — CrispLens FastAPI v2 — VPS / container deployment
#
# All interactive prompts can be bypassed with environment variables:
#
#   CRISP_INSTALL_DIR   install directory              (default: /opt/crisp-lens)
#   CRISP_SVC_USER      system user to run service     (default: face-rec)
#   CRISP_SVC_NAME      systemd service name           (default: face-rec)
#   CRISP_PORT          listen port                    (default: first free ≥ 7865)
#   CRISP_WORKERS       uvicorn worker count           (default: 1)
#   CRISP_ADMIN_USER    bootstrap admin username       (required)
#   CRISP_ADMIN_PASS    bootstrap admin password       (required, ≥ 8 chars)
#   CRISP_DOMAIN        reverse-proxy domain           (omit to skip web server setup)
#   CRISP_WEB_SERVER    nginx|apache2 — web server     (auto-detected: apache2 if running)
#   CRISP_SSL           true|false — Let's Encrypt     (default: false)
#   CRISP_SSL_EMAIL     email for Let's Encrypt        (required if CRISP_SSL=true)
#   CRISP_YES=1         skip the "Proceed?" confirmation prompt
#
# Container mode (auto-detected from /.dockerenv, /run/.containerenv, cgroup,
# or set CRISP_CONTAINER=1 explicitly):
#   • Skips: systemd service, system user creation, nginx, sudo
#   • Writes start.sh entrypoint — use as Docker CMD / ENTRYPOINT
#   • Server binds to 0.0.0.0 (not 127.0.0.1) — terminate TLS at host/LB
#   • Admin credentials are NOT baked into the image; pass at 'docker run' time
#     via -e CRISP_ADMIN_USER / -e CRISP_ADMIN_PASS
#
# Examples:
#
#   # Interactive VPS deploy
#   sudo bash deploy-v2.sh
#
#   # Fully automated VPS deploy (CI / Ansible / cloud-init)
#   export CRISP_ADMIN_USER=admin
#   export CRISP_ADMIN_PASS='s3cr3t!X9'
#   export CRISP_DOMAIN=faces.example.com
#   export CRISP_SSL=true
#   export CRISP_SSL_EMAIL=ops@example.com
#   export CRISP_YES=1
#   sudo -E bash deploy-v2.sh
#
#   # Docker image build step (in Dockerfile or CI)
#   CRISP_CONTAINER=1 CRISP_INSTALL_DIR=/app bash deploy-v2.sh
#
# =============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

info()  { echo -e "  ${GREEN}✔${NC}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; }
error() { echo -e "  ${RED}✘${NC}  $*" >&2; }
step()  { echo -e "\n${BOLD}${BLUE}▶  $*${NC}"; }
hr()    { echo -e "${DIM}$(printf '─%.0s' {1..68})${NC}"; }
die()   { error "$*"; exit 1; }

# ── Container detection ───────────────────────────────────────────────────────
IN_CONTAINER=false
if   [[ "${CRISP_CONTAINER:-0}" == "1" ]]; then
    IN_CONTAINER=true
elif [[ -f /.dockerenv ]]; then
    IN_CONTAINER=true
elif [[ -f /run/.containerenv ]]; then
    IN_CONTAINER=true
elif grep -qE '(docker|lxc|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
    IN_CONTAINER=true
fi

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash deploy-v2.sh"

# ── OS detection ─────────────────────────────────────────────────────────────
if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"; OS_VER="${VERSION_ID:-?}"
else
    OS_ID="unknown"; OS_VER="?"
fi
[[ "$OS_ID" =~ ^(ubuntu|debian)$ ]] \
    || warn "Untested OS '${OS_ID}' — script targets Ubuntu/Debian; continuing"

# ── Prompt helpers ────────────────────────────────────────────────────────────
# prompt_if_unset VAR_NAME "label" "default"
# If the named env var is empty, prompts the user and sets it globally.
prompt_if_unset() {
    local _v=$1 _lbl=$2 _def=$3
    local _cur="${!_v:-}"
    [[ -n "$_cur" ]] && return
    local _val
    read -rp "  ${_lbl} [${_def}]: " _val
    eval "${_v}=\"\${_val:-\${_def}}\""
}

# prompt_secret_if_unset VAR_NAME "label" min_len
prompt_secret_if_unset() {
    local _v=$1 _lbl=$2 _min=${3:-1}
    local _cur="${!_v:-}"
    if [[ -n "$_cur" ]]; then
        [[ ${#_cur} -ge $_min ]] || die "$_v must be at least ${_min} characters"
        return
    fi
    local _val
    while true; do
        read -rsp "  ${_lbl} (min ${_min} chars): " _val; echo
        [[ ${#_val} -ge $_min ]] && break
        warn "Too short — minimum ${_min} characters required"
    done
    # confirm
    local _val2
    read -rsp "  Confirm ${_lbl}: " _val2; echo
    [[ "$_val" == "$_val2" ]] || die "Passwords do not match"
    eval "${_v}=\"\${_val}\""
}

# prompt_bool_if_unset VAR_NAME "label" default(true|false)
prompt_bool_if_unset() {
    local _v=$1 _lbl=$2 _def=$3
    local _cur="${!_v:-}"
    [[ -n "$_cur" ]] && return
    local _hint="[Y/n]"; [[ "$_def" == "false" ]] && _hint="[y/N]"
    local _inp
    read -rp "  ${_lbl}? ${_hint}: " _inp
    if [[ -z "$_inp" ]]; then
        eval "${_v}=\"\${_def}\""
    elif [[ "${_inp,,}" =~ ^(y|yes)$ ]]; then
        eval "${_v}=\"true\""
    else
        eval "${_v}=\"false\""
    fi
}

# ── Port helpers ──────────────────────────────────────────────────────────────
find_free_port() {
    local p=$1
    local _cmd="ss -tlnp"
    command -v ss &>/dev/null || _cmd="netstat -tlnp"
    while $_cmd 2>/dev/null | grep -qE ":${p}[[:space:]]|:${p}$"; do (( p++ )); done
    echo "$p"
}

show_listening_ports() {
    echo -e "\n${DIM}  Currently listening ports:${NC}"
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | awk 'NR>1 {
            split($4,a,":"); port=a[length(a)]
            n=$6; gsub(/.*pid=/,"",n); gsub(/[,)].*/,"",n)
            printf "    %-7s %s\n", port, n
        }' | sort -n | head -25
    fi
    echo
}

# ── YAML patcher (uses Python so result is always valid YAML) ─────────────────
patch_config_key() {
    local cfg=$1 key=$2 val=$3
    python3 - "$cfg" "$key" "$val" <<'PYEOF'
import sys, re
cfg_path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
if val.lower() == 'true':    val_py = True
elif val.lower() == 'false': val_py = False
else:
    try:    val_py = int(val)
    except: val_py = val
try:
    import yaml
    with open(cfg_path) as fh: data = yaml.safe_load(fh) or {}
    parts = key.split('.')
    node = data
    for p in parts[:-1]: node = node.setdefault(p, {})
    node[parts[-1]] = val_py
    with open(cfg_path, 'w') as fh:
        yaml.dump(data, fh, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"    patched {key} = {val_py!r}")
except ImportError:
    leaf = parts[-1]
    text = open(cfg_path).read()
    pattern = rf'^(\s*{re.escape(leaf)}:\s*).*$'
    repl = rf'\g<1>{str(val_py).lower()}' if isinstance(val_py, bool) else rf'\g<1>{val_py}'
    open(cfg_path, 'w').write(re.sub(pattern, repl, text, count=1, flags=re.MULTILINE))
    print(f"    patched (regex) {leaf} = {val_py!r}")
PYEOF
}

# ── systemd service (VPS only) ────────────────────────────────────────────────
create_service() {
    local svc=$1 user=$2 dir=$3 port=$4 workers=$5 adm_user=$6 adm_pass=$7

    # Build optional bootstrap env lines (only included when non-empty)
    local admin_env=""
    [[ -n "$adm_user" ]] && admin_env+="Environment=\"CRISP_ADMIN_USER=${adm_user}\"\n"
    [[ -n "$adm_pass" ]] && admin_env+="Environment=\"CRISP_ADMIN_PASS=${adm_pass}\"\n"

    # Write the unit file; printf handles the optional block cleanly
    {
        printf '[Unit]\n'
        printf 'Description=CrispLens Face Recognition (FastAPI v2)\n'
        printf 'After=network-online.target\n'
        printf 'Wants=network-online.target\n'
        printf '\n[Service]\n'
        printf 'Type=simple\n'
        printf 'User=%s\n' "$user"
        printf 'Group=%s\n' "$user"
        printf 'WorkingDirectory=%s\n' "$dir"
        printf 'Environment="PATH=%s/venv/bin:/usr/local/bin:/usr/bin:/bin"\n' "$dir"
        printf 'Environment="FACE_REC_PORT=%s"\n' "$port"
        printf 'Environment="FACE_REC_DATA_DIR=%s"\n' "$dir"
        printf 'Environment="FACE_REC_WORKERS=%s"\n' "$workers"
        printf 'Environment="CRISP_HTTPS_COOKIES=1"\n'
        [[ -n "$admin_env" ]] && printf '%b' "$admin_env"
        printf 'ExecStart=%s/venv/bin/uvicorn fastapi_app:app \\\n' "$dir"
        printf '    --host 127.0.0.1 \\\n'
        printf '    --port %s \\\n' "$port"
        printf '    --workers %s \\\n' "$workers"
        printf '    --log-level info\n'
        printf 'Restart=on-failure\n'
        printf 'RestartSec=10\n'
        printf 'StandardOutput=journal\n'
        printf 'StandardError=journal\n'
        printf 'SyslogIdentifier=%s\n' "$svc"
        printf '\n# Hardening\n'
        printf 'NoNewPrivileges=yes\n'
        printf 'PrivateTmp=yes\n'
        printf 'ProtectSystem=full\n'
        printf 'ReadWritePaths=%s\n' "$dir"
        printf '\n[Install]\n'
        printf 'WantedBy=multi-user.target\n'
    } > "/etc/systemd/system/${svc}.service"

    systemctl daemon-reload
    systemctl enable "${svc}" --quiet
    info "systemd service '${svc}' registered and enabled"
}

# ── Container entrypoint ──────────────────────────────────────────────────────
create_entrypoint() {
    local dir=$1
    cat > "${dir}/start.sh" <<'STARTEOF'
#!/usr/bin/env bash
# CrispLens container entrypoint — generated by deploy-v2.sh
#
# Runtime environment variables (pass with: docker run -e VAR=value ...):
#   FACE_REC_PORT         listen port         (default: 7865)
#   FACE_REC_DATA_DIR     data directory      (default: /data)
#   FACE_REC_WORKERS      uvicorn workers     (default: 1)
#   FACE_REC_DB_PATH      absolute DB path    (optional)
#   FACE_REC_LOG_LEVEL    log level           (default: info)
#   CRISP_ADMIN_USER      bootstrap admin username  (first start only)
#   CRISP_ADMIN_PASS      bootstrap admin password  (first start only)
set -e
: "${FACE_REC_PORT:=7865}"
: "${FACE_REC_DATA_DIR:=/data}"
: "${FACE_REC_WORKERS:=1}"
: "${FACE_REC_LOG_LEVEL:=info}"
mkdir -p "$FACE_REC_DATA_DIR"
export FACE_REC_DATA_DIR
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${SCRIPT_DIR}/venv/bin/uvicorn" fastapi_app:app \
    --host 0.0.0.0 \
    --port  "$FACE_REC_PORT" \
    --workers "$FACE_REC_WORKERS" \
    --log-level "$FACE_REC_LOG_LEVEL"
STARTEOF
    chmod +x "${dir}/start.sh"
    info "Entrypoint written: ${dir}/start.sh"
}

# ── nginx site ────────────────────────────────────────────────────────────────
create_nginx_site() {
    local domain=$1 port=$2 svc=$3
    local conf="/etc/nginx/sites-available/${svc}"

    if grep -rl "server_name.*${domain}" /etc/nginx/sites-enabled/ 2>/dev/null \
            | grep -qv "${svc}"; then
        warn "Another nginx site already claims '${domain}' — check for conflicts"
    fi

    cat > "$conf" <<EOF
# CrispLens FastAPI v2 — ${domain}
# Generated by deploy-v2.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    client_max_body_size 500M;

    # SSE (batch processing streams) — must not buffer
    location /api/ {
        proxy_pass              http://127.0.0.1:${port};
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        proxy_buffering         off;
        proxy_cache             off;
        proxy_set_header        Connection        '';
        chunked_transfer_encoding on;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
    }

    # Svelte SPA + static files
    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF
    ln -sf "$conf" "/etc/nginx/sites-enabled/${svc}"
    nginx -t || die "nginx config test failed — check ${conf}"
    systemctl reload nginx
    info "nginx configured: ${domain} → 127.0.0.1:${port}"
}

# ── Apache2 site ──────────────────────────────────────────────────────────────
create_apache2_site() {
    local domain=$1 port=$2 svc=$3
    local conf="/etc/apache2/sites-available/${svc}.conf"

    # Enable required modules
    for _mod in proxy proxy_http headers rewrite; do
        a2enmod --quiet "$_mod" 2>/dev/null \
            && info "Apache2 module enabled: mod_${_mod}" || true
    done

    # Write HTTP vhost (certbot --apache adds HTTPS block automatically)
    cat > "$conf" <<EOF
# CrispLens FastAPI v2 — ${domain}
# Generated by deploy-v2.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
<VirtualHost *:80>
    ServerName ${domain}

    # Large uploads (500 MB)
    LimitRequestBody 524288000

    # SSE / streaming — disable all proxy buffering
    SetEnv proxy-initial-not-buffered 1
    SetEnv proxy-sendchunked 1

    ProxyPreserveHost On
    ProxyTimeout      3600
    Timeout           3600

    ProxyPass        / http://127.0.0.1:${port}/ flushpackets=on
    ProxyPassReverse / http://127.0.0.1:${port}/

    RequestHeader set X-Real-IP       "%{REMOTE_ADDR}s"
    RequestHeader set X-Forwarded-Proto "http"
</VirtualHost>
EOF

    a2ensite --quiet "${svc}" 2>/dev/null || true
    apachectl configtest 2>&1 | tail -3 \
        || die "Apache2 config test failed — check ${conf}"
    systemctl reload apache2
    info "Apache2 configured: ${domain} → 127.0.0.1:${port}"
}

# ── run_as helper — sudo to service user on VPS, direct in container ──────────
run_as() {
    if [[ "$IN_CONTAINER" == false && -n "${CRISP_SVC_USER:-}" ]]; then
        sudo -u "${CRISP_SVC_USER}" "$@"
    else
        "$@"
    fi
}

# =============================================================================
# MAIN
# =============================================================================

echo
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║      CrispLens — FastAPI v2 — Deployment Script              ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo -e "  ${DIM}OS: ${OS_ID} ${OS_VER}   Host: $(hostname -f 2>/dev/null || hostname)${NC}"
[[ "$IN_CONTAINER" == true ]] \
    && echo -e "  ${YELLOW}Container mode — systemd / nginx / sudo skipped${NC}"

[[ "$IN_CONTAINER" == false ]] && show_listening_ports

# ── Collect configuration ─────────────────────────────────────────────────────
step "Configuration"
hr

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo -e "  ${DIM}Source:  ${SCRIPT_DIR}${NC}"
echo

if [[ "$IN_CONTAINER" == true ]]; then
    # Lean container defaults — no user/service/nginx prompts
    : "${CRISP_INSTALL_DIR:=/app}"
    : "${CRISP_PORT:=7865}"
    : "${CRISP_WORKERS:=1}"
else
    prompt_if_unset  CRISP_INSTALL_DIR  "Install directory"                "/opt/crisp-lens"
    prompt_if_unset  CRISP_SVC_USER     "System user (created if missing)" "face-rec"
    prompt_if_unset  CRISP_SVC_NAME     "systemd service name"             "face-rec"

    if [[ -z "${CRISP_PORT:-}" ]]; then
        DEFAULT_PORT=$(find_free_port 7865)
        prompt_if_unset CRISP_PORT "App port" "$DEFAULT_PORT"
    fi
    [[ "${CRISP_PORT}" =~ ^[0-9]+$ ]] || die "CRISP_PORT must be numeric"

    prompt_if_unset CRISP_WORKERS "Uvicorn worker count" "1"
fi

# Admin credentials — required in all modes
prompt_if_unset     CRISP_ADMIN_USER "Admin username" "admin"
prompt_secret_if_unset CRISP_ADMIN_PASS "Admin password" 8

# Reverse proxy / SSL (VPS only)
DO_NGINX=false
DO_SSL=false
WEB_SERVER=""
if [[ "$IN_CONTAINER" == false ]]; then
    if [[ -z "${CRISP_DOMAIN:-}" ]]; then
        prompt_bool_if_unset _do_nginx "Set up reverse proxy (nginx or Apache2)" "true"
        if [[ "${_do_nginx:-false}" == "true" ]]; then
            prompt_if_unset CRISP_DOMAIN "Domain / subdomain (e.g. faces.example.com)" ""
            [[ -n "${CRISP_DOMAIN:-}" ]] || die "Domain cannot be empty when reverse proxy is selected"
        fi
    fi

    if [[ -n "${CRISP_DOMAIN:-}" ]]; then
        DO_NGINX=true
        prompt_bool_if_unset CRISP_SSL "Enable HTTPS with Let's Encrypt" "false"
        DO_SSL="${CRISP_SSL:-false}"
        if [[ "$DO_SSL" == "true" ]]; then
            prompt_if_unset CRISP_SSL_EMAIL "Email for Let's Encrypt" ""
            [[ -n "${CRISP_SSL_EMAIL:-}" ]] || die "CRISP_SSL_EMAIL required when CRISP_SSL=true"
        fi
    fi

    # Auto-detect web server (honour override, else detect running apache2, else nginx)
    if [[ "$DO_NGINX" == true ]]; then
        if [[ -n "${CRISP_WEB_SERVER:-}" ]]; then
            WEB_SERVER="${CRISP_WEB_SERVER}"
            info "Web server forced via CRISP_WEB_SERVER: ${WEB_SERVER}"
        elif systemctl is-active --quiet apache2 2>/dev/null; then
            WEB_SERVER="apache2"
            info "Apache2 detected — will add a new vhost (nginx will NOT be installed)"
        else
            WEB_SERVER="nginx"
        fi
    fi
fi

# ── Summary & confirm ─────────────────────────────────────────────────────────
echo
hr
echo -e "  ${BOLD}Deployment plan${NC}"; echo
echo -e "  Source dir    :  ${SCRIPT_DIR}"
echo -e "  Install dir   :  ${CRISP_INSTALL_DIR}"
if [[ "$IN_CONTAINER" == true ]]; then
    echo -e "  Mode          :  Container  (start.sh entrypoint)"
    echo -e "  Bind port     :  0.0.0.0:${CRISP_PORT}"
else
    echo -e "  Service user  :  ${CRISP_SVC_USER}"
    echo -e "  Service name  :  ${CRISP_SVC_NAME}"
    echo -e "  App port      :  127.0.0.1:${CRISP_PORT} (internal)"
    echo -e "  Workers       :  ${CRISP_WORKERS}"
fi
echo -e "  Admin user    :  ${CRISP_ADMIN_USER}"
if [[ "$DO_NGINX" == true ]]; then
    echo -e "  Web server    :  ${WEB_SERVER}  →  ${CRISP_DOMAIN}  →  127.0.0.1:${CRISP_PORT}"
    [[ "$DO_SSL" == true ]] \
        && echo -e "  TLS           :  Let's Encrypt (${CRISP_SSL_EMAIL})" \
        || echo -e "  TLS           :  none (add later: certbot --${WEB_SERVER} -d ${CRISP_DOMAIN})"
fi
echo; hr; echo

if [[ "${CRISP_YES:-0}" != "1" ]]; then
    read -rp "  Proceed? [y/N]: " _go
    [[ "${_go,,}" == "y" ]] || { echo "  Aborted."; exit 0; }
fi

# =============================================================================
# PHASE 1 — system packages
# =============================================================================
step "Installing system packages"

apt-get update -qq

PKGS=(
    python3 python3-pip python3-venv python3-dev python3-yaml
    git curl rsync sqlite3 build-essential
    libssl-dev libffi-dev libgl1 libglib2.0-0
    exiftool
)
if [[ "$DO_NGINX" == true ]]; then
    [[ "$WEB_SERVER" == "nginx" ]]   && PKGS+=(nginx)
    if [[ "$DO_SSL" == true ]]; then
        [[ "$WEB_SERVER" == "nginx" ]]   && PKGS+=(certbot python3-certbot-nginx)
        [[ "$WEB_SERVER" == "apache2" ]] && PKGS+=(certbot python3-certbot-apache)
    fi
fi

apt-get install -y -qq "${PKGS[@]}"
info "System packages ready"

# ── Start nginx if it was selected and is not yet running ─────────────────────
if [[ "$DO_NGINX" == true && "$WEB_SERVER" == "nginx" && "$IN_CONTAINER" == false ]]; then
    if ! systemctl is-active --quiet nginx 2>/dev/null; then
        systemctl start nginx 2>/dev/null \
            && info "nginx started" \
            || warn "nginx failed to start — check: systemctl status nginx"
    fi
fi

# ── Best available Python 3.10+ ───────────────────────────────────────────────
# Resolve full path so sudo -u <svc_user> can find it regardless of PATH.
PYTHON=""
for _py in python3.13 python3.12 python3.11 python3.10 python3; do
    _full=$(command -v "$_py" 2>/dev/null || true)
    [[ -z "$_full" ]] && continue
    _minor=$("$_full" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)
    if [[ $_minor -ge 10 ]]; then
        PYTHON="$_full"   # store absolute path — safe across sudo
        info "Python: $($PYTHON --version) at $PYTHON"
        break
    fi
done
[[ -n "$PYTHON" ]] || die "Python 3.10+ not found — check apt sources or install via deadsnakes PPA"

# =============================================================================
# PHASE 2 — Node.js (Svelte frontend build)
# =============================================================================
step "Node.js (Svelte frontend build)"

RENDERER_DIR="${SCRIPT_DIR}/electron-app-v2/renderer"
DIST_DIR="${RENDERER_DIR}/dist"
NEED_BUILD=false

if [[ -d "${DIST_DIR}" && -f "${DIST_DIR}/index.html" ]]; then
    info "Pre-built Svelte dist/ found — skipping Node.js install"
else
    NEED_BUILD=true
    if ! command -v node &>/dev/null; then
        info "Installing Node.js 20 via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
        apt-get install -y -qq nodejs
        info "Node.js $(node --version) installed"
    else
        info "Node.js $(node --version) already present"
    fi
fi

# =============================================================================
# PHASE 3 — service user (VPS only)
# =============================================================================
if [[ "$IN_CONTAINER" == false ]]; then
    step "Service user: ${CRISP_SVC_USER}"
    if id "${CRISP_SVC_USER}" &>/dev/null; then
        info "User '${CRISP_SVC_USER}' already exists"
    else
        useradd --system --create-home --shell /usr/sbin/nologin "${CRISP_SVC_USER}"
        info "User '${CRISP_SVC_USER}' created"
    fi
fi

# =============================================================================
# PHASE 4 — application files
# =============================================================================
step "Installing application files → ${CRISP_INSTALL_DIR}"

if [[ "${SCRIPT_DIR}" == "${CRISP_INSTALL_DIR}" ]]; then
    info "Source = install directory — no copy needed"
else
    mkdir -p "${CRISP_INSTALL_DIR}"
    rsync -a \
        --exclude='venv/' \
        --exclude='node_modules/' \
        --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
        --exclude='*.index' \
        --exclude='.api_secret_key' \
        --exclude='__pycache__/' --exclude='*.pyc' --exclude='*.pyo' \
        --exclude='uploads/' --exclude='training_data/' \
        --exclude='logs/' --exclude='backups/' --exclude='exports/' \
        --exclude='thumbnails/' --exclude='face_crops/' \
        --exclude='.git/' \
        "${SCRIPT_DIR}/" "${CRISP_INSTALL_DIR}/"
    info "Files synced to ${CRISP_INSTALL_DIR}"
fi

for _dir in logs backups uploads training_data exports thumbnails datasets; do
    mkdir -p "${CRISP_INSTALL_DIR}/${_dir}"
done

if [[ "$IN_CONTAINER" == false ]]; then
    chown -R "${CRISP_SVC_USER}:${CRISP_SVC_USER}" "${CRISP_INSTALL_DIR}"
    info "Ownership set to ${CRISP_SVC_USER}"
fi

# =============================================================================
# PHASE 5 — Python venv + dependencies
# =============================================================================
step "Python virtual environment"

VENV="${CRISP_INSTALL_DIR}/venv"
if [[ ! -d "${VENV}" ]]; then
    run_as "$PYTHON" -m venv "${VENV}"
    info "venv created (${VENV})"
else
    info "venv already exists — reusing"
fi

step "Installing Python dependencies"
run_as "${VENV}/bin/pip" install --upgrade pip -q

REQ="${CRISP_INSTALL_DIR}/requirements.txt"
if [[ -f "$REQ" ]]; then
    run_as "${VENV}/bin/pip" install -q -r "$REQ" \
        || die "pip install failed — check output above"
    info "Dependencies installed from requirements.txt"
else
    warn "requirements.txt not found — installing core packages directly"
    run_as "${VENV}/bin/pip" install -q \
        fastapi "uvicorn[standard]" pydantic python-multipart pyyaml requests pillow \
        insightface onnxruntime faiss-cpu opencv-python-headless numpy \
        bcrypt cryptography openai anthropic \
        || die "pip install failed"
    info "Core packages installed"
fi

# Optional: visual duplicate detection (non-fatal)
run_as "${VENV}/bin/pip" install -q imagehash \
    && info "imagehash installed (visual duplicate detection enabled)" \
    || warn "imagehash not installed — visual duplicate detection unavailable"

# =============================================================================
# PHASE 6 — Svelte frontend build
# =============================================================================
step "Svelte frontend"

INSTALL_RENDERER="${CRISP_INSTALL_DIR}/electron-app-v2/renderer"
INSTALL_DIST="${INSTALL_RENDERER}/dist"

if [[ "$NEED_BUILD" == true ]]; then
    if command -v npm &>/dev/null; then
        info "Building Svelte frontend..."
        run_as bash -c "
            cd '${INSTALL_RENDERER}'
            npm install --prefer-offline --loglevel=error
            npm run build --silent
        "
        if [[ -f "${INSTALL_DIST}/index.html" ]]; then
            info "Svelte frontend built → ${INSTALL_DIST}"
        else
            warn "dist/index.html not found after build — check npm output"
        fi
    else
        warn "npm not found and no pre-built dist/ present"
        warn "Run manually: cd ${INSTALL_RENDERER} && npm install && npm run build"
    fi
else
    info "Using pre-built dist/ — no rebuild needed"
fi

# =============================================================================
# PHASE 7 — config.yaml
# =============================================================================
step "Configuration (config.yaml)"

CFG="${CRISP_INSTALL_DIR}/config.yaml"

if [[ ! -f "$CFG" ]]; then
    if [[ -f "${CRISP_INSTALL_DIR}/config.example.yaml" ]]; then
        cp "${CRISP_INSTALL_DIR}/config.example.yaml" "$CFG"
        info "config.yaml created from config.example.yaml"
    else
        warn "config.yaml missing — create ${CFG} before starting the service"
    fi
fi

if [[ -f "$CFG" ]]; then
    cp "${CFG}" "${CFG}.bak.$(date +%s)"
    # Linux: no Apple Neural Engine
    patch_config_key "$CFG" "face_recognition.insightface.use_coreml" "false"
    # Defer heavy model load until first request (faster startup, especially in containers)
    patch_config_key "$CFG" "face_recognition.lazy_init" "true"
    [[ "$IN_CONTAINER" == false ]] && chown "${CRISP_SVC_USER}:${CRISP_SVC_USER}" "${CFG}"
    info "config.yaml patched for Linux"
fi

# =============================================================================
# PHASE 8 — database
# =============================================================================
step "Database"

DB="${CRISP_INSTALL_DIR}/face_recognition.db"
if [[ -f "$DB" ]]; then
    info "Database already exists ($(du -sh "$DB" | cut -f1)) — skipping init"
else
    SCHEMA="${CRISP_INSTALL_DIR}/schema_complete.sql"
    if [[ -f "$SCHEMA" ]]; then
        run_as sqlite3 "$DB" < "$SCHEMA"
        info "Database initialised from schema_complete.sql"
    else
        warn "schema_complete.sql not found — DB will be auto-created on first run"
    fi
fi

# =============================================================================
# PHASE 9 — startup: systemd service (VPS) or start.sh entrypoint (container)
# =============================================================================
if [[ "$IN_CONTAINER" == false ]]; then
    step "systemd service"

    if systemctl is-active --quiet "${CRISP_SVC_NAME}" 2>/dev/null; then
        warn "Service '${CRISP_SVC_NAME}' is running — stopping for update"
        systemctl stop "${CRISP_SVC_NAME}"
    fi

    create_service \
        "${CRISP_SVC_NAME}" "${CRISP_SVC_USER}" "${CRISP_INSTALL_DIR}" \
        "${CRISP_PORT}"     "${CRISP_WORKERS:-1}" \
        "${CRISP_ADMIN_USER}" "${CRISP_ADMIN_PASS}"

    step "Starting service"
    systemctl start "${CRISP_SVC_NAME}"
    sleep 4

    if systemctl is-active --quiet "${CRISP_SVC_NAME}"; then
        info "Service '${CRISP_SVC_NAME}' is running"
    else
        error "Service failed to start — last 40 log lines:"
        journalctl -u "${CRISP_SVC_NAME}" -n 40 --no-pager
        die "Fix the issue above, then:  systemctl start ${CRISP_SVC_NAME}"
    fi

    sleep 2
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        "http://127.0.0.1:${CRISP_PORT}/api/health" --max-time 10 || echo "000")
    if [[ "$HTTP_STATUS" == "200" ]]; then
        info "/api/health → HTTP ${HTTP_STATUS} ✔"
    else
        warn "/api/health returned HTTP ${HTTP_STATUS} (model may still be warming up)"
    fi
else
    step "Container entrypoint"
    create_entrypoint "${CRISP_INSTALL_DIR}"
fi

# =============================================================================
# PHASE 10 — reverse proxy (VPS only)
# =============================================================================
if [[ "$DO_NGINX" == true && "$IN_CONTAINER" == false ]]; then
    if [[ "$WEB_SERVER" == "apache2" ]]; then
        step "Apache2 reverse proxy"
        create_apache2_site "${CRISP_DOMAIN}" "${CRISP_PORT}" "${CRISP_SVC_NAME}"
    else
        step "nginx reverse proxy"
        create_nginx_site "${CRISP_DOMAIN}" "${CRISP_PORT}" "${CRISP_SVC_NAME}"
    fi
fi

# =============================================================================
# PHASE 11 — TLS / Let's Encrypt (VPS only)
# =============================================================================
if [[ "$DO_SSL" == true && "$IN_CONTAINER" == false ]]; then
    step "Let's Encrypt TLS"

    SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || true)
    DOMAIN_IP=$(getent hosts "${CRISP_DOMAIN}" | awk '{print $1}' | head -1)
    if [[ -n "$SERVER_IP" && "${DOMAIN_IP:-}" != "$SERVER_IP" ]]; then
        warn "DNS: ${CRISP_DOMAIN} → ${DOMAIN_IP:-unresolved}, server → ${SERVER_IP}"
        warn "Certificate may fail if DNS hasn't propagated yet"
        if [[ "${CRISP_YES:-0}" != "1" ]]; then
            read -rp "  Continue anyway? [y/N]: " _dns_cont
            [[ "${_dns_cont,,}" == "y" ]] || {
                warn "Skipping certbot — run manually later:"
                echo "    certbot --${WEB_SERVER} -d ${CRISP_DOMAIN} --agree-tos -m ${CRISP_SSL_EMAIL}"
                DO_SSL=false
            }
        fi
    fi

    if [[ "$DO_SSL" == true ]]; then
        _cb_plugin="--${WEB_SERVER}"
        if certbot ${_cb_plugin} -d "${CRISP_DOMAIN}" \
                --non-interactive --agree-tos -m "${CRISP_SSL_EMAIL}" \
                --redirect 2>&1 | tail -5; then
            info "TLS certificate installed, HTTP→HTTPS redirect active"
        else
            warn "certbot reported an error — retry: certbot ${_cb_plugin} -d ${CRISP_DOMAIN}"
        fi
    fi
fi

# =============================================================================
# DONE
# =============================================================================
echo; hr
echo -e "  ${BOLD}${GREEN}Deployment complete!${NC}"; echo

if [[ "$IN_CONTAINER" == true ]]; then
    echo -e "  ${BOLD}Entrypoint:${NC}  ${CRISP_INSTALL_DIR}/start.sh"
    echo
    echo -e "  ${DIM}Sample docker run:${NC}"
    echo -e "    docker run -p 7865:7865 \\"
    echo -e "      -v /your/data:/data \\"
    echo -e "      -e FACE_REC_DATA_DIR=/data \\"
    echo -e "      -e CRISP_ADMIN_USER=admin \\"
    echo -e "      -e CRISP_ADMIN_PASS='<pass>' \\"
    echo -e "      <image>"
    echo
    echo -e "  ${DIM}Admin credentials are passed at runtime — not baked into the image.${NC}"
else
    if [[ "$DO_NGINX" == true && "$DO_SSL" == true ]]; then
        APP_URL="https://${CRISP_DOMAIN}"
    elif [[ "$DO_NGINX" == true ]]; then
        APP_URL="http://${CRISP_DOMAIN}"
    else
        APP_URL="http://$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo '<server-ip>'):${CRISP_PORT}"
    fi

    echo -e "  ${BOLD}URL:${NC}   ${APP_URL}"
    echo -e "  ${BOLD}Login:${NC} ${CRISP_ADMIN_USER}  /  <password you set>"
    echo
    echo -e "  ${DIM}Useful commands:${NC}"
    echo -e "    journalctl -u ${CRISP_SVC_NAME} -f              # live logs"
    echo -e "    systemctl status  ${CRISP_SVC_NAME}"
    echo -e "    systemctl restart ${CRISP_SVC_NAME}"
    echo
    echo -e "  ${DIM}Update after git pull (install dir = repo):${NC}"
    echo -e "    cd ${CRISP_INSTALL_DIR} && sudo -u ${CRISP_SVC_USER} git pull"
    echo -e "    sudo -u ${CRISP_SVC_USER} ${VENV}/bin/pip install -q -r requirements.txt"
    echo -e "    cd electron-app-v2/renderer && sudo -u ${CRISP_SVC_USER} npm run build && cd ../.."
    echo -e "    systemctl restart ${CRISP_SVC_NAME}"
    echo
    echo -e "  ${DIM}Or — if repo and install dir are separate:${NC}"
    echo -e "    cd /your/repo && git pull && sudo bash fix_db.sh"
fi

echo
echo -e "  ${DIM}Install path:${NC}  ${CRISP_INSTALL_DIR}"
echo -e "  ${DIM}Config:${NC}        ${CRISP_INSTALL_DIR}/config.yaml"
echo -e "  ${DIM}Database:${NC}      ${CRISP_INSTALL_DIR}/face_recognition.db"
[[ "$IN_CONTAINER" == false ]] \
    && echo -e "  ${DIM}Logs:${NC}          journalctl -u ${CRISP_SVC_NAME}"
hr; echo
