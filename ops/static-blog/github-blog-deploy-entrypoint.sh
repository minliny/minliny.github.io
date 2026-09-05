#!/usr/bin/env bash
set -euo pipefail

# Forced-command policy. These values are assigned before the shared library is
# sourced, exported to the deployer, and made readonly below. SSH environment
# requests therefore cannot redirect a production deployment or weaken checks.
BLOG_INCOMING_DIR="/opt/releases/blog/.incoming"
BLOG_RELEASES_DIR="/opt/releases/blog"
BLOG_CURRENT_LINK="/srv/blog/current"
BLOG_LOCK_FILE="/opt/releases/blog/.deploy.lock"
BLOG_DEPLOY_REPO="minliny/minliny.github.io"
BLOG_DEPLOY_SITE_URL="https://blog.minliny.com"
BLOG_LOCAL_ORIGIN="http://127.0.0.1:8080"
BLOG_HTTP_HOST="blog.minliny.com"
BLOG_CURL_RESOLVE=""
BLOG_CURL_CA_CERT=""
BLOG_HEALTH_ATTEMPTS="10"
BLOG_HEALTH_INTERVAL_SECONDS="1"
BLOG_MAX_ARCHIVE_BYTES="536870912"
BLOG_MAX_UNPACKED_BYTES="1073741824"
BLOG_MAX_FILES="100000"
BLOG_ALLOW_MKDIR_LOCK_FALLBACK="0"
export BLOG_INCOMING_DIR BLOG_RELEASES_DIR BLOG_CURRENT_LINK BLOG_LOCK_FILE
export BLOG_DEPLOY_REPO BLOG_DEPLOY_SITE_URL
export BLOG_LOCAL_ORIGIN BLOG_HTTP_HOST BLOG_CURL_RESOLVE BLOG_CURL_CA_CERT
export BLOG_HEALTH_ATTEMPTS BLOG_HEALTH_INTERVAL_SECONDS
export BLOG_MAX_ARCHIVE_BYTES BLOG_MAX_UNPACKED_BYTES BLOG_MAX_FILES
export BLOG_ALLOW_MKDIR_LOCK_FALLBACK

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib-static-blog.sh
source "$SCRIPT_DIR/lib-static-blog.sh"

readonly BLOG_INCOMING_DIR BLOG_RELEASES_DIR BLOG_CURRENT_LINK BLOG_LOCK_FILE
readonly BLOG_DEPLOY_REPO BLOG_DEPLOY_SITE_URL
readonly BLOG_LOCAL_ORIGIN BLOG_HTTP_HOST BLOG_CURL_RESOLVE BLOG_CURL_CA_CERT
readonly BLOG_HEALTH_ATTEMPTS BLOG_HEALTH_INTERVAL_SECONDS
readonly BLOG_MAX_ARCHIVE_BYTES BLOG_MAX_UNPACKED_BYTES BLOG_MAX_FILES
readonly BLOG_ALLOW_MKDIR_LOCK_FALLBACK

original_command="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$original_command" =~ ^deploy\ ([0-9a-f]{40})\ ([0-9]+)\ ([0-9a-f]{64})$ ]]; then
  die "command rejected"
fi

commit="${BASH_REMATCH[1]}"
run_id="${BASH_REMATCH[2]}"
expected_sha256="${BASH_REMATCH[3]}"
validate_release_fields \
  "$BLOG_DEPLOY_REPO" "$commit" "$run_id" "$BLOG_DEPLOY_SITE_URL" "$expected_sha256"
[[ "$BLOG_MAX_ARCHIVE_BYTES" =~ ^[1-9][0-9]*$ ]] \
  || die "BLOG_MAX_ARCHIVE_BYTES must be a positive integer"
[[ -d "$BLOG_INCOMING_DIR" && ! -L "$BLOG_INCOMING_DIR" ]] \
  || die "incoming directory must be a regular directory: $BLOG_INCOMING_DIR"

umask 077
partial="$BLOG_INCOMING_DIR/.blog-${commit}-${run_id}.tar.gz.part.$$"
artifact="$BLOG_INCOMING_DIR/blog-${commit}-${run_id}.tar.gz"

cleanup_entrypoint() {
  [[ -f "${partial:-}" ]] && rm -f -- "$partial"
}
trap cleanup_entrypoint EXIT

actual_sha256="$(python3 -c '
import hashlib
import os
import sys

destination, max_bytes_text = sys.argv[1:]
max_bytes = int(max_bytes_text)
digest = hashlib.sha256()
received = 0

try:
    with open(destination, "xb") as output:
        while True:
            chunk = sys.stdin.buffer.read(1024 * 1024)
            if not chunk:
                break
            received += len(chunk)
            if received > max_bytes:
                raise RuntimeError(f"archive exceeds {max_bytes} bytes")
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
except Exception as exc:
    try:
        os.unlink(destination)
    except FileNotFoundError:
        pass
    raise SystemExit(str(exc))

print(digest.hexdigest())
' "$partial" "$BLOG_MAX_ARCHIVE_BYTES")"

[[ "$actual_sha256" == "$expected_sha256" ]] \
  || die "received artifact SHA-256 mismatch"

# A hard link gives create-if-absent semantics, avoiding a race that could make
# an ordinary mv overwrite another upload with the same commit/run id. A racing
# identical retry may win first; that is accepted after validating its file.
python3 - "$partial" "$artifact" "$expected_sha256" <<'PY'
import hashlib
import os
import stat
import sys

partial, artifact, expected = sys.argv[1:]
try:
    os.link(partial, artifact)
except FileExistsError:
    pass

mode = os.lstat(artifact).st_mode
if not stat.S_ISREG(mode):
    raise SystemExit("existing incoming artifact is not a regular file")
digest = hashlib.sha256()
with open(artifact, "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected:
    raise SystemExit("existing incoming artifact checksum does not match retry")
os.unlink(partial)
PY
partial=""

exec "$SCRIPT_DIR/deploy-static-blog.sh" \
  "$artifact" "$expected_sha256" \
  "$BLOG_DEPLOY_REPO" "$commit" "$run_id" "$BLOG_DEPLOY_SITE_URL"
