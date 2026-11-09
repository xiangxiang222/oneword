#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-140.143.171.77}"
DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
DIR="${DEPLOY_DIR:-/var/www/oneword}"
KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
RELEASE="$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD)"
[[ "$DIR" =~ ^/var/www/[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid deploy directory'; exit 1; }
[[ "$HOST" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid host'; exit 1; }
[[ -f "$ROOT/web/dist/index.html" ]] || (cd "$ROOT" && npm run build)
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_USER@$HOST")
"${SSH[@]}" "sudo mkdir -p '$DIR/releases/$RELEASE' && sudo chown -R '$DEPLOY_USER:$DEPLOY_USER' '$DIR'"
rsync -az --delete --timeout=120 -e "ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes" \
  --exclude '.git/' --exclude 'node_modules/' --exclude '.env*' --exclude 'test-results/' \
  --exclude 'web/src/generated/' --exclude 'server/data/' --exclude '.DS_Store' \
  "$ROOT/" "$DEPLOY_USER@$HOST:$DIR/releases/$RELEASE/"
"${SSH[@]}" bash -s -- "$DIR" "$RELEASE" <<'REMOTE'
set -Eeuo pipefail
DIR="$1"
RELEASE="$2"
TARGET="$DIR/releases/$RELEASE"
cd "$TARGET"
npm ci --prefix server --omit=dev --no-fund
mkdir -p "$DIR/data" "$DIR/backups"
chmod 700 "$DIR/data" "$DIR/backups"
# SQLite's online backup includes committed WAL records. Releases and rollback
# never replace the shared database, and every update keeps a consistent copy.
if [ -f "$DIR/data/oneword.sqlite" ]; then
  node - "$TARGET" "$DIR/data/oneword.sqlite" "$DIR/backups/$RELEASE.sqlite" <<'DATABASE'
const path = require('node:path');
const Database = require(path.join(process.argv[2], 'server/node_modules/better-sqlite3'));
const database = new Database(process.argv[3], { readonly: true });
database.backup(process.argv[4]).then(() => database.close()).catch(error => { console.error('Database backup failed:', error.message); process.exitCode = 1; database.close(); });
DATABASE
  chmod 600 "$DIR/backups/$RELEASE.sqlite"
fi
printf '%s\n' "$RELEASE" > "$TARGET/.release-id"
OLD="$(readlink "$DIR/current" || true)"
NGINX_PATH=/etc/nginx/sites-available/beiyexing
NGINX_SNAPSHOT="$TARGET/.nginx-before"
sudo cp "$NGINX_PATH" "$NGINX_SNAPSHOT"
NGINX_CHANGED=false
rollback() {
  trap - ERR
  set +e
  echo 'Deployment failed; restoring previous release.' >&2
  if [ "$NGINX_CHANGED" = true ]; then
    sudo cp "$NGINX_SNAPSHOT" "$NGINX_PATH"
    sudo nginx -t && sudo systemctl reload nginx
  fi
  if [ -n "$OLD" ]; then
    ln -sfn "$OLD" "$DIR/current.next"
    mv -Tf "$DIR/current.next" "$DIR/current"
    pm2 startOrReload "$DIR/current/ecosystem.config.cjs" --update-env || true
  else
    pm2 delete oneword >/dev/null 2>&1 || true
    rm -f "$DIR/current"
  fi
  pm2 save >/dev/null 2>&1 || true
  exit 1
}
trap rollback ERR
ln -sfn "$TARGET" "$DIR/current.next"
mv -Tf "$DIR/current.next" "$DIR/current"
pm2 startOrReload "$DIR/current/ecosystem.config.cjs" --update-env
check_release() {
  local payload
  payload="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "$1")" || return 1
  HEALTH_PAYLOAD="$payload" python3 - "$RELEASE" <<'PYHEALTH'
import json, os, sys
try:
    health = json.loads(os.environ['HEALTH_PAYLOAD'])
    assert health.get('ok') is True and health.get('service') == 'oneword'
    assert health.get('releaseId') == sys.argv[1]
except (ValueError, AssertionError):
    raise SystemExit(1)
PYHEALTH
}
for attempt in $(seq 1 20); do
  if check_release http://127.0.0.1:3795/oneword/api/health; then break; fi
  sleep 1
done
check_release http://127.0.0.1:3795/oneword/api/health
sudo python3 "$TARGET/scripts/patch-nginx.py"
if ! sudo cmp -s "$NGINX_PATH" "$NGINX_SNAPSHOT"; then NGINX_CHANGED=true; fi
sudo nginx -t
sudo systemctl reload nginx
for attempt in $(seq 1 5); do
  if check_release https://togetherbetter.cn/oneword/api/health; then break; fi
  sleep 2
done
check_release https://togetherbetter.cn/oneword/api/health
pm2 save
trap - ERR
REMOTE
printf '\nDeployed: https://togetherbetter.cn/oneword/\n'
