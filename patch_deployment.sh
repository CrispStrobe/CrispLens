#!/usr/bin/env bash
# =============================================================================
# patch_deployment.sh — CrispLens — patch an EXISTING running installation
#
# Run this script when you deployed from an older version of deploy-v2.sh and
# need to apply the following fixes to the live server WITHOUT a full redeploy:
#
#   FIX 1 — Sudoers NOPASSWD
#            Adds /etc/sudoers.d/crisp-lens so that the face-rec service user
#            can run "sudo bash fix_db.sh" without a shell password.
#            (Service accounts have no shell password; sudo -S always fails.)
#
#   FIX 2 — Remove NoNewPrivileges=yes from systemd unit
#            Older deploy scripts set NoNewPrivileges=yes which blocks all
#            setuid binaries including sudo.  The admin "Update Server" feature
#            silently fails with exit code 1 when this is set.
#
#   FIX 3 — Apache ProxyHTTPVersion 1.1 + <Location> blocks
#            Without these fixes Apache buffers API and SSE responses so that
#            the browser's fetch/ReadableStream hangs indefinitely:
#              ProxyHTTPVersion 1.1  — force HTTP/1.1 to uvicorn so that
#                                      chunked transfer encoding is used and
#                                      flushpackets=on works per-chunk (HTTP/1.0
#                                      causes full buffering until conn closes)
#              <Location /api>     SetEnv no-gzip 1  (disables deflate buffer)
#              <Location /api/admin>  SetEnv proxy-nokeepalive 1 (force flush)
#
#   FIX 4 — config.yaml  admin.fix_db_path
#            Records the path to fix_db.sh in config.yaml so the admin UI
#            finds it without manual config editing.
#
# Usage:
#   sudo bash patch_deployment.sh [options]
#
# Options (env vars):
#   CRISP_INSTALL_DIR   install dir       (default: auto-detected from service)
#   CRISP_SVC_NAME      service name      (default: face-rec)
#   CRISP_SVC_USER      service user      (default: from service unit)
#   CRISP_FIX_DB_PATH   fix_db.sh path   (default: CRISP_INSTALL_DIR/fix_db.sh)
#   CRISP_YES=1         skip confirmation
#
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

info()  { echo -e "  ${GREEN}✔${NC}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; }
step()  { echo -e "\n${BOLD}${BLUE}▶  $*${NC}"; }
skip()  { echo -e "  ${DIM}  (already correct — skipped): $*${NC}"; }
die()   { echo -e "  ${RED}✘${NC}  $*" >&2; exit 1; }
hr()    { echo -e "${DIM}$(printf '─%.0s' {1..68})${NC}"; }

[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash patch_deployment.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║      CrispLens — patch_deployment.sh — Live Server Patcher   ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo

# =============================================================================
# Auto-detect service name + install dir
# =============================================================================
step "Auto-detecting existing installation"

SVC_NAME="${CRISP_SVC_NAME:-face-rec}"

# Find service unit file
UNIT_FILE=""
for _candidate in \
        "/etc/systemd/system/${SVC_NAME}.service" \
        "/lib/systemd/system/${SVC_NAME}.service"; do
    if [[ -f "$_candidate" ]]; then
        UNIT_FILE="$_candidate"
        info "Found service unit: ${UNIT_FILE}"
        break
    fi
done

[[ -n "$UNIT_FILE" ]] || die "Systemd unit not found for service '${SVC_NAME}'.
Set CRISP_SVC_NAME to override, e.g.:  CRISP_SVC_NAME=myservice sudo bash patch_deployment.sh"

# Extract install dir from WorkingDirectory= in the unit file
if [[ -z "${CRISP_INSTALL_DIR:-}" ]]; then
    CRISP_INSTALL_DIR=$(grep -oP '(?<=WorkingDirectory=).*' "$UNIT_FILE" | head -1)
fi
[[ -n "${CRISP_INSTALL_DIR:-}" ]] || die "Could not detect install dir — set CRISP_INSTALL_DIR"
info "Install dir: ${CRISP_INSTALL_DIR}"

# Extract service user
if [[ -z "${CRISP_SVC_USER:-}" ]]; then
    CRISP_SVC_USER=$(grep -oP '(?<=^User=).*' "$UNIT_FILE" | head -1)
fi
CRISP_SVC_USER="${CRISP_SVC_USER:-face-rec}"
info "Service user: ${CRISP_SVC_USER}"

# Resolve fix_db.sh path
FIX_DB_PATH="${CRISP_FIX_DB_PATH:-${SCRIPT_DIR}/fix_db.sh}"
# Fall back to install dir if script dir doesn't have fix_db.sh
[[ -f "$FIX_DB_PATH" ]] || FIX_DB_PATH="${CRISP_INSTALL_DIR}/fix_db.sh"
info "fix_db.sh:   ${FIX_DB_PATH}"

# Detect Apache config
APACHE_SITES_DIR=""
for _d in /etc/apache2/sites-enabled /etc/httpd/sites-enabled; do
    [[ -d "$_d" ]] && { APACHE_SITES_DIR="$_d"; break; }
done

APACHE_CONF=""
if [[ -n "$APACHE_SITES_DIR" ]]; then
    # Find the site that proxies to us (by looking for ProxyPass with our port)
    _port=$(grep -oP '(?<=FACE_REC_PORT=)\d+' "$UNIT_FILE" | head -1 || true)
    if [[ -n "$_port" ]]; then
        APACHE_CONF=$(grep -rl "127.0.0.1:${_port}" "$APACHE_SITES_DIR" 2>/dev/null | head -1 || true)
    fi
    # Fallback: find a conf that mentions face-rec or crisp-lens
    if [[ -z "$APACHE_CONF" ]]; then
        APACHE_CONF=$(grep -rl -i -E 'crisp.?lens|face.?rec' "$APACHE_SITES_DIR" 2>/dev/null | head -1 || true)
    fi
    [[ -n "$APACHE_CONF" ]] \
        && info "Apache config: ${APACHE_CONF}" \
        || warn "Apache config not auto-detected — FIX 3 will be skipped"
fi

echo
hr
echo -e "  ${BOLD}Patch plan${NC}"; echo
echo -e "    FIX 1  Sudoers NOPASSWD       ${FIX_DB_PATH}"
echo -e "    FIX 2  NoNewPrivileges        remove from ${UNIT_FILE}"
if [[ -n "$APACHE_CONF" ]]; then
    echo -e "    FIX 3  Apache HTTP/1.1+Location  ${APACHE_CONF}"
else
    echo -e "    FIX 3  Apache HTTP/1.1+Location  SKIPPED (conf not found)"
fi
echo -e "    FIX 4  config.yaml            admin.fix_db_path"
hr; echo

if [[ "${CRISP_YES:-0}" != "1" ]]; then
    read -rp "  Proceed? [y/N]: " _go
    [[ "${_go,,}" == "y" ]] || { echo "  Aborted."; exit 0; }
fi

# =============================================================================
# FIX 1 — Sudoers NOPASSWD
# =============================================================================
step "FIX 1: Sudoers NOPASSWD for ${CRISP_SVC_USER}"

SUDOERS_FILE="/etc/sudoers.d/crisp-lens"
SUDOERS_LINE="${CRISP_SVC_USER} ALL=(ALL) NOPASSWD: /bin/bash ${FIX_DB_PATH}"

_write_sudoers=false
if [[ -f "$SUDOERS_FILE" ]]; then
    if grep -qF "$SUDOERS_LINE" "$SUDOERS_FILE"; then
        skip "Sudoers entry already correct in ${SUDOERS_FILE}"
    else
        _write_sudoers=true
        warn "Sudoers entry outdated — overwriting"
    fi
else
    _write_sudoers=true
fi

if [[ "$_write_sudoers" == true ]]; then
    echo "$SUDOERS_LINE" > "$SUDOERS_FILE"
    chmod 440 "$SUDOERS_FILE"
    if visudo -c -f "$SUDOERS_FILE" &>/dev/null; then
        info "Sudoers drop-in written: ${SUDOERS_FILE}"
        info "  → ${SUDOERS_LINE}"
    else
        warn "Sudoers syntax check failed — removing ${SUDOERS_FILE}"
        rm -f "$SUDOERS_FILE"
        die "Could not write sudoers — check manually: visudo -c -f ${SUDOERS_FILE}"
    fi
fi

# =============================================================================
# FIX 2 — Remove NoNewPrivileges=yes from systemd unit
# =============================================================================
step "FIX 2: Remove NoNewPrivileges=yes from ${UNIT_FILE}"

if grep -qE '^NoNewPrivileges\s*=\s*yes' "$UNIT_FILE"; then
    cp "${UNIT_FILE}" "${UNIT_FILE}.bak.$(date +%s)"
    # Replace the line with a comment explaining why it was removed
    sed -i 's|^NoNewPrivileges\s*=\s*yes|# NoNewPrivileges intentionally omitted: sudo (setuid) required for admin update|' "$UNIT_FILE"
    systemctl daemon-reload
    info "NoNewPrivileges=yes removed and service unit reloaded"
    info "  (backup saved as ${UNIT_FILE}.bak.*)"
    NEED_SERVICE_RESTART=true
else
    skip "NoNewPrivileges=yes not present"
    NEED_SERVICE_RESTART=false
fi

# =============================================================================
# FIX 3 — Apache <Location> blocks inside VirtualHost
# =============================================================================
step "FIX 3: Apache <Location> blocks"

if [[ -z "$APACHE_CONF" ]]; then
    warn "Apache config not found — skipping this fix."
    warn "Apply manually: add these blocks inside every VirtualHost that proxies CrispLens:"
    cat <<'APACHEHELP'

    # Inside your <VirtualHost *:443> (or :80) block, before ProxyPass:

    ProxyHTTPVersion 1.1
    ProxyPass        / http://127.0.0.1:PORT/ flushpackets=on
    ProxyPassReverse / http://127.0.0.1:PORT/

    <Location /api>
        SetEnv no-gzip 1
        SetEnv dont-vary 1
    </Location>

    <Location /api/admin>
        SetEnv proxy-nokeepalive 1
    </Location>

APACHEHELP
else
    # Use Python to patch the Apache config reliably.
    # Strategy: for every VirtualHost block that contains a ProxyPass line,
    # insert the two Location blocks before </VirtualHost> if not already present.
    python3 - "$APACHE_CONF" <<'PYEOF'
import sys, re, shutil, os

conf_path = sys.argv[1]
with open(conf_path) as fh:
    text = fh.read()

API_LOC   = '\n    <Location /api>\n        SetEnv no-gzip 1\n        SetEnv dont-vary 1\n    </Location>\n'
ADMIN_LOC = '\n    <Location /api/admin>\n        SetEnv proxy-nokeepalive 1\n    </Location>\n'

def already_has(block, tag):
    """Return True if block already contains <Location tag"""
    return bool(re.search(rf'<Location\s+{re.escape(tag)}\s*>', block, re.IGNORECASE))

vhost_pat = re.compile(
    r'(<VirtualHost[^>]*>.*?</VirtualHost>)',
    re.DOTALL | re.IGNORECASE
)

changed = False
def patch_vhost(m):
    global changed
    block = m.group(1)
    # Only patch VirtualHost blocks that proxy to uvicorn (have ProxyPass)
    if not re.search(r'ProxyPass', block, re.IGNORECASE):
        return block

    insert = ''
    if not already_has(block, '/api'):
        insert += API_LOC
    if not already_has(block, '/api/admin'):
        insert += ADMIN_LOC

    needs_http11 = not re.search(r'ProxyHTTPVersion\s+1\.1', block, re.IGNORECASE)

    if not insert and not needs_http11:
        return block

    patched = block
    if insert:
        # Insert Location blocks just before </VirtualHost>
        patched = re.sub(
            r'(</VirtualHost>)',
            insert + r'\1',
            patched,
            count=1,
            flags=re.IGNORECASE
        )
    if needs_http11:
        # Insert ProxyHTTPVersion 1.1 before the first ProxyPass line
        patched = re.sub(
            r'(\n[ \t]*ProxyPass\b)',
            r'\n    ProxyHTTPVersion 1.1\1',
            patched,
            count=1,
            flags=re.IGNORECASE
        )
    changed = True
    return patched

new_text = vhost_pat.sub(patch_vhost, text)

if changed:
    shutil.copy2(conf_path, conf_path + '.bak.' + str(int(__import__('time').time())))
    with open(conf_path, 'w') as fh:
        fh.write(new_text)
    print('patched')
else:
    print('already_ok')
PYEOF

    PATCH_RESULT=$(python3 - "$APACHE_CONF" <<'PYEOF2'
import sys, re
conf_path = sys.argv[1]
with open(conf_path) as fh:
    text = fh.read()
vhosts = re.findall(r'<VirtualHost[^>]*>.*?</VirtualHost>', text, re.DOTALL | re.IGNORECASE)
for v in vhosts:
    if re.search(r'ProxyPass', v, re.IGNORECASE):
        has_api   = bool(re.search(r'<Location\s+/api\s*>', v, re.IGNORECASE))
        has_admin = bool(re.search(r'<Location\s+/api/admin\s*>', v, re.IGNORECASE))
        if has_api and has_admin:
            print("already_ok"); sys.exit()
        else:
            print("needs_patch"); sys.exit()
print("no_vhost_found")
PYEOF2
    )

    # Re-run the actual patcher
    python3 - "$APACHE_CONF" <<'PYEOF3'
import sys, re, shutil, time

conf_path = sys.argv[1]
with open(conf_path) as fh:
    text = fh.read()

API_LOC   = '\n    <Location /api>\n        SetEnv no-gzip 1\n        SetEnv dont-vary 1\n    </Location>\n'
ADMIN_LOC = '\n    <Location /api/admin>\n        SetEnv proxy-nokeepalive 1\n    </Location>\n'

def already_has(block, tag):
    return bool(re.search(rf'<Location\s+{re.escape(tag)}\s*>', block, re.IGNORECASE))

vhost_pat = re.compile(r'(<VirtualHost[^>]*>.*?</VirtualHost>)', re.DOTALL | re.IGNORECASE)
changed = False

def patch_vhost(m):
    global changed
    block = m.group(1)
    if not re.search(r'ProxyPass', block, re.IGNORECASE):
        return block
    insert = ''
    if not already_has(block, '/api'):
        insert += API_LOC
    if not already_has(block, '/api/admin'):
        insert += ADMIN_LOC
    needs_http11 = not re.search(r'ProxyHTTPVersion\s+1\.1', block, re.IGNORECASE)
    if not insert and not needs_http11:
        return block
    patched = block
    if insert:
        patched = re.sub(r'(</VirtualHost>)', insert + r'\1', patched, count=1, flags=re.IGNORECASE)
    if needs_http11:
        patched = re.sub(
            r'(\n[ \t]*ProxyPass\b)',
            r'\n    ProxyHTTPVersion 1.1\1',
            patched, count=1, flags=re.IGNORECASE
        )
    changed = True
    return patched

new_text = vhost_pat.sub(patch_vhost, text)

if changed:
    shutil.copy2(conf_path, conf_path + '.bak.' + str(int(time.time())))
    with open(conf_path, 'w') as fh:
        fh.write(new_text)
    print("  patched: ProxyHTTPVersion 1.1 + Location blocks added inside VirtualHost")
else:
    print("  already correct — no changes made")
PYEOF3

    # Validate and reload Apache
    APACHE_BIN=""
    for _ab in apachectl apache2ctl httpd; do
        command -v "$_ab" &>/dev/null && { APACHE_BIN="$_ab"; break; }
    done

    if [[ -n "$APACHE_BIN" ]]; then
        if "$APACHE_BIN" configtest 2>&1 | grep -q "Syntax OK"; then
            info "Apache config test: Syntax OK"
            if systemctl is-active --quiet apache2 2>/dev/null || systemctl is-active --quiet httpd 2>/dev/null; then
                systemctl reload apache2 2>/dev/null || systemctl reload httpd 2>/dev/null || true
                info "Apache reloaded"
            fi
        else
            warn "Apache config test FAILED — review ${APACHE_CONF} and restore from .bak if needed"
            "$APACHE_BIN" configtest 2>&1 | tail -10
        fi
    else
        warn "Could not find apachectl/apache2ctl — please run: sudo apachectl configtest && sudo systemctl reload apache2"
    fi
fi

# =============================================================================
# FIX 4 — config.yaml admin.fix_db_path
# =============================================================================
step "FIX 4: config.yaml admin.fix_db_path"

CFG="${CRISP_INSTALL_DIR}/config.yaml"
if [[ ! -f "$CFG" ]]; then
    warn "config.yaml not found at ${CFG} — skipping"
else
    python3 - "$CFG" "admin.fix_db_path" "$FIX_DB_PATH" <<'PYEOF'
import sys, re
cfg_path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    import yaml
    with open(cfg_path) as fh: data = yaml.safe_load(fh) or {}
    parts = key.split('.')
    node = data
    for p in parts[:-1]: node = node.setdefault(p, {})
    if node.get(parts[-1]) == val:
        print("  already correct — no changes made")
        sys.exit(0)
    node[parts[-1]] = val
    with open(cfg_path, 'w') as fh:
        yaml.dump(data, fh, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"  patched: admin.fix_db_path = {val!r}")
except ImportError:
    leaf = parts[-1]
    text = open(cfg_path).read()
    if re.search(rf'^\s*{re.escape(leaf)}\s*:', text, re.MULTILINE):
        current = re.search(rf'^\s*{re.escape(leaf)}\s*:\s*(.*)', text, re.MULTILINE)
        if current and current.group(1).strip() == val:
            print("  already correct — no changes made")
            sys.exit(0)
        text = re.sub(rf'^(\s*{re.escape(leaf)}\s*:).*$', rf'\g<1> {val}', text, flags=re.MULTILINE)
    else:
        text += f'\n# written by patch_deployment.sh\nadmin:\n  fix_db_path: {val}\n'
    open(cfg_path, 'w').write(text)
    print(f"  patched (regex): {leaf} = {val!r}")
PYEOF
fi

# =============================================================================
# Restart service if unit file was modified
# =============================================================================
step "Restarting service: ${SVC_NAME}"

if [[ "${NEED_SERVICE_RESTART:-false}" == true ]]; then
    systemctl restart "${SVC_NAME}"
    sleep 3
    if systemctl is-active --quiet "${SVC_NAME}"; then
        info "Service '${SVC_NAME}' restarted and running"
    else
        warn "Service failed to restart — check: journalctl -u ${SVC_NAME} -n 30"
    fi
else
    # Still do a soft restart to pick up config changes
    if systemctl is-active --quiet "${SVC_NAME}"; then
        systemctl restart "${SVC_NAME}"
        sleep 3
        systemctl is-active --quiet "${SVC_NAME}" \
            && info "Service '${SVC_NAME}' restarted" \
            || warn "Service did not come up — check: journalctl -u ${SVC_NAME} -n 30"
    else
        warn "Service '${SVC_NAME}' not running — start it: systemctl start ${SVC_NAME}"
    fi
fi

# =============================================================================
# Verification hints
# =============================================================================
echo
hr
echo -e "  ${BOLD}${GREEN}Patch complete!${NC}"; echo

echo -e "  ${DIM}Verify sudoers:${NC}"
echo -e "    sudo -u ${CRISP_SVC_USER} sudo -n bash ${FIX_DB_PATH} --dry-run 2>&1 || echo 'sudo test failed'"
echo
echo -e "  ${DIM}Verify service (no NoNewPrivileges):${NC}"
echo -e "    systemctl show ${SVC_NAME} | grep -i NoNewPrivileges"
echo -e "    # Should be empty or 'NoNewPrivileges=no'"
echo
if [[ -n "$APACHE_CONF" ]]; then
    echo -e "  ${DIM}Verify Apache config:${NC}"
    echo -e "    apachectl configtest"
    echo -e "    grep -A3 'Location /api' ${APACHE_CONF}"
    echo
fi
echo -e "  ${DIM}Test SSE streaming from UI:${NC}"
echo -e "    Settings → Admin → Server Management → Update Server"
echo -e "    (should stream live output, not hang)"
echo
echo -e "  ${DIM}Live service logs:${NC}"
echo -e "    journalctl -u ${SVC_NAME} -f"
echo
hr; echo
