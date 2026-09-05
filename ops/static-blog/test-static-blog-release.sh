#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib-static-blog.sh
source "$SCRIPT_DIR/lib-static-blog.sh"

require_command python3
require_command tar
require_command curl

(
  unset BLOG_LOCAL_ORIGIN BLOG_HTTP_HOST BLOG_CURL_RESOLVE
  # shellcheck source=lib-static-blog.sh
  source "$SCRIPT_DIR/lib-static-blog.sh"
  [[ "$BLOG_LOCAL_ORIGIN" == "http://127.0.0.1:8080" ]]
  [[ "$BLOG_HTTP_HOST" == "blog.minliny.com" ]]
  [[ -z "$BLOG_CURL_RESOLVE" ]]
)

test_root="$(mktemp -d "${TMPDIR:-/tmp}/blog-release-test.XXXXXX")"
server_pid=""

cleanup_test() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$test_root"
}
trap cleanup_test EXIT

incoming="$test_root/incoming"
releases="$test_root/releases"
web="$test_root/www"
mkdir -p "$incoming" "$releases" "$web"

port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$test_root" \
  >"$test_root/http.log" 2>&1 &
server_pid="$!"

for _ in 1 2 3 4 5; do
  if curl --fail --silent "http://127.0.0.1:$port/" >/dev/null; then
    break
  fi
  sleep 0.2
done
curl --fail --silent "http://127.0.0.1:$port/" >/dev/null

export BLOG_INCOMING_DIR="$incoming"
export BLOG_RELEASES_DIR="$releases"
export BLOG_CURRENT_LINK="$web/current"
export BLOG_LOCAL_ORIGIN="http://127.0.0.1:$port/www/current"
export BLOG_HTTP_HOST="blog.test"
export BLOG_CURL_RESOLVE=""
export BLOG_HEALTH_ATTEMPTS=2
export BLOG_HEALTH_INTERVAL_SECONDS=0
export BLOG_ALLOW_MKDIR_LOCK_FALLBACK=1

make_site() {
  local destination="$1"
  local marker="$2"
  mkdir -p "$destination/assets" "$destination/posts/$marker"
  cat >"$destination/index.html" <<EOF
<!doctype html><html><head><link rel="canonical" href="https://blog.test/"><link rel="stylesheet" href="style.css?v=1"><script defer src="theme.js?v=1"></script></head><body>$marker</body></html>
EOF
  : >"$destination/.nojekyll"
  printf '{"source":"notion","siteUrl":"https://blog.test","articleCount":1,"marker":"%s"}\n' "$marker" >"$destination/content-manifest.json"
  printf '[{"slug":"%s","path":"posts/%s/"}]\n' "$marker" "$marker" >"$destination/posts.json"
  printf '<!doctype html><title>%s</title>\n' "$marker" >"$destination/posts/$marker/index.html"
  printf '<rss><channel><link>https://blog.test</link><title>%s</title></channel></rss>\n' "$marker" >"$destination/feed.xml"
  printf '<urlset><url><loc>https://blog.test/%s</loc></url></urlset>\n' "$marker" >"$destination/sitemap.xml"
  printf '%s\n' "$marker" >"$destination/assets/app.css"
  printf 'body { color: black; } /* %s */\n' "$marker" >"$destination/style.css"
  printf 'document.documentElement.dataset.build = "%s";\n' "$marker" >"$destination/theme.js"
}

make_artifact() {
  local source="$1"
  local archive="$2"
  tar -czf "$archive" -C "$source" .
}

expect_failure() {
  if "$@" >"$test_root/expected-failure.log" 2>&1; then
    printf 'expected command to fail: %q ' "$@" >&2
    printf '\n' >&2
    exit 1
  fi
}

site_v1="$test_root/site-v1"
archive_v1="$incoming/blog-v1.tar.gz"
make_site "$site_v1" "v1"
make_artifact "$site_v1" "$archive_v1"
sha_v1="$(sha256_file "$archive_v1")"

"$SCRIPT_DIR/deploy-static-blog.sh" \
  "$archive_v1" "$sha_v1" minliny/minliny.github.io aaaaaaa 101 https://blog.test
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]
[[ -f "$releases/aaaaaaa-101/.nojekyll" ]]
"$SCRIPT_DIR/verify-static-blog.sh" "$releases/aaaaaaa-101"

bad_offline="$test_root/bad-offline"
cp -a "$releases/aaaaaaa-101" "$bad_offline"
python3 - "$bad_offline/content-manifest.json" <<'PY'
import json
import sys
path = sys.argv[1]
with open(path, encoding="utf-8") as source:
    payload = json.load(source)
payload["siteUrl"] = "https://wrong.test"
with open(path, "w", encoding="utf-8") as output:
    json.dump(payload, output)
PY
expect_failure "$SCRIPT_DIR/verify-static-blog.sh" "$bad_offline"
rm -rf -- "$bad_offline"

cp -a "$releases/aaaaaaa-101" "$bad_offline"
rm -- "$bad_offline/posts/v1/index.html"
expect_failure "$SCRIPT_DIR/verify-static-blog.sh" "$bad_offline"
rm -rf -- "$bad_offline"

cp -a "$releases/aaaaaaa-101" "$bad_offline"
rm -- "$bad_offline/style.css"
expect_failure "$SCRIPT_DIR/verify-static-blog.sh" "$bad_offline"
rm -rf -- "$bad_offline"

"$SCRIPT_DIR/deploy-static-blog.sh" \
  "$archive_v1" "$sha_v1" minliny/minliny.github.io aaaaaaa 101 https://blog.test
expect_failure "$SCRIPT_DIR/deploy-static-blog.sh" \
  "$archive_v1" "$sha_v1" another/repo aaaaaaa 101 https://blog.test
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]

site_v2="$test_root/site-v2"
archive_v2="$incoming/blog-v2.tar.gz"
make_site "$site_v2" "v2"
make_artifact "$site_v2" "$archive_v2"
sha_v2="$(sha256_file "$archive_v2")"
if [[ "${sha_v2:0:1}" == "0" ]]; then
  bad_sha_v2="1${sha_v2:1}"
else
  bad_sha_v2="0${sha_v2:1}"
fi

expect_failure "$SCRIPT_DIR/deploy-static-blog.sh" \
  "$archive_v2" "$bad_sha_v2" minliny/minliny.github.io bbbbbbb 202 https://blog.test
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]

symlink_site="$test_root/site-link"
make_site "$symlink_site" "link"
ln -s /etc/passwd "$symlink_site/assets/escape"
symlink_archive="$incoming/blog-link.tar.gz"
make_artifact "$symlink_site" "$symlink_archive"
symlink_sha="$(sha256_file "$symlink_archive")"
expect_failure "$SCRIPT_DIR/deploy-static-blog.sh" \
  "$symlink_archive" "$symlink_sha" minliny/minliny.github.io ccccccc 303 https://blog.test
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]

traversal_archive="$incoming/blog-traversal.tar.gz"
python3 - "$traversal_archive" <<'PY'
import io
import tarfile
import sys
with tarfile.open(sys.argv[1], "w:gz") as tar:
    payload = b"escape"
    info = tarfile.TarInfo("../escape")
    info.size = len(payload)
    tar.addfile(info, io.BytesIO(payload))
PY
traversal_sha="$(sha256_file "$traversal_archive")"
expect_failure "$SCRIPT_DIR/deploy-static-blog.sh" \
  "$traversal_archive" "$traversal_sha" minliny/minliny.github.io ddddddd 404 https://blog.test
[[ ! -e "$test_root/escape" ]]
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]

"$SCRIPT_DIR/deploy-static-blog.sh" \
  "$archive_v2" "$sha_v2" minliny/minliny.github.io bbbbbbb 202 https://blog.test
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/bbbbbbb-202" ]]

mkdir "$releases/deadbee-999"
expect_failure "$SCRIPT_DIR/rollback-static-blog.sh" deadbee-999
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/bbbbbbb-202" ]]

"$SCRIPT_DIR/rollback-static-blog.sh" aaaaaaa-101
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]

site_v3="$test_root/site-v3"
archive_v3="$incoming/blog-v3.tar.gz"
make_site "$site_v3" "v3"
make_artifact "$site_v3" "$archive_v3"
sha_v3="$(sha256_file "$archive_v3")"

# Serve v1 from a fixed path. v3 passes offline checks, switches, then its HTTP
# response mismatches and the deployer must restore v1 automatically.
export BLOG_LOCAL_ORIGIN="http://127.0.0.1:$port/releases/aaaaaaa-101"
expect_failure "$SCRIPT_DIR/deploy-static-blog.sh" \
  "$archive_v3" "$sha_v3" minliny/minliny.github.io eeeeeee 505 https://blog.test
[[ -d "$releases/eeeeeee-505" ]]
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/aaaaaaa-101" ]]

export BLOG_LOCAL_ORIGIN="http://127.0.0.1:$port/www/current"
"$SCRIPT_DIR/rollback-static-blog.sh" bbbbbbb-202
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/bbbbbbb-202" ]]
[[ -d "$releases/aaaaaaa-101" && -d "$releases/eeeeeee-505" ]]

# The production forced entrypoint intentionally ignores environment overrides.
# Exercise the same code with a temporary copy whose fixed production constants
# are replaced before execution, so the self-test never touches /opt or /srv.
entrypoint_scripts="$test_root/entrypoint-scripts"
mkdir "$entrypoint_scripts"
cp "$SCRIPT_DIR"/*.sh "$entrypoint_scripts/"
python3 - \
  "$entrypoint_scripts/github-blog-deploy-entrypoint.sh" \
  "$incoming" "$releases" "$web/current" \
  "http://127.0.0.1:$port/www/current" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
incoming, releases, current, local_origin = sys.argv[2:]
text = path.read_text(encoding="utf-8")
replacements = [
    ('BLOG_INCOMING_DIR="/opt/releases/blog/.incoming"', f'BLOG_INCOMING_DIR="{incoming}"'),
    ('BLOG_RELEASES_DIR="/opt/releases/blog"', f'BLOG_RELEASES_DIR="{releases}"'),
    ('BLOG_CURRENT_LINK="/srv/blog/current"', f'BLOG_CURRENT_LINK="{current}"'),
    ('BLOG_LOCK_FILE="/opt/releases/blog/.deploy.lock"', f'BLOG_LOCK_FILE="{releases}/.deploy.lock"'),
    ('BLOG_DEPLOY_SITE_URL="https://blog.minliny.com"', 'BLOG_DEPLOY_SITE_URL="https://blog.test"'),
    ('BLOG_LOCAL_ORIGIN="http://127.0.0.1:8080"', f'BLOG_LOCAL_ORIGIN="{local_origin}"'),
    ('BLOG_HTTP_HOST="blog.minliny.com"', 'BLOG_HTTP_HOST="blog.test"'),
    ('BLOG_HEALTH_ATTEMPTS="10"', 'BLOG_HEALTH_ATTEMPTS="2"'),
    ('BLOG_HEALTH_INTERVAL_SECONDS="1"', 'BLOG_HEALTH_INTERVAL_SECONDS="0"'),
    ('BLOG_ALLOW_MKDIR_LOCK_FALLBACK="0"', 'BLOG_ALLOW_MKDIR_LOCK_FALLBACK="1"'),
]
for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit(f"expected one forced-entrypoint constant: {old}")
    text = text.replace(old, new)
path.write_text(text, encoding="utf-8")
PY
entrypoint="$entrypoint_scripts/github-blog-deploy-entrypoint.sh"

entry_commit=ffffffffffffffffffffffffffffffffffffffff
entry_run_id=606
if [[ "${sha_v1:0:1}" == "0" ]]; then
  bad_sha_v1="1${sha_v1:1}"
else
  bad_sha_v1="0${sha_v1:1}"
fi

expect_failure env \
  SSH_ORIGINAL_COMMAND="bash -c whoami" \
  "$entrypoint" <"$archive_v1"
[[ ! -e "$incoming/blog-${entry_commit}-${entry_run_id}.tar.gz" ]]

expect_failure env \
  SSH_ORIGINAL_COMMAND="deploy $entry_commit $entry_run_id $bad_sha_v1" \
  "$entrypoint" <"$archive_v1"
[[ ! -e "$incoming/blog-${entry_commit}-${entry_run_id}.tar.gz" ]]
[[ ! -e "$releases/${entry_commit}-${entry_run_id}" ]]

env \
  BLOG_INCOMING_DIR="$test_root/injected-incoming" \
  BLOG_RELEASES_DIR="$test_root/injected-releases" \
  BLOG_CURRENT_LINK="$test_root/injected-current" \
  BLOG_LOCK_FILE="$test_root/injected.lock" \
  BLOG_DEPLOY_REPO=attacker/repository \
  BLOG_DEPLOY_SITE_URL=https://attacker.invalid \
  BLOG_LOCAL_ORIGIN=http://127.0.0.1:1 \
  BLOG_HTTP_HOST=attacker.invalid \
  BLOG_CURL_RESOLVE=attacker.invalid:80:127.0.0.1 \
  BLOG_CURL_CA_CERT=/does/not/exist \
  BLOG_HEALTH_ATTEMPTS=999 \
  BLOG_HEALTH_INTERVAL_SECONDS=99 \
  BLOG_MAX_ARCHIVE_BYTES=1 \
  BLOG_MAX_UNPACKED_BYTES=1 \
  BLOG_MAX_FILES=1 \
  BLOG_ALLOW_MKDIR_LOCK_FALLBACK=0 \
  SSH_ORIGINAL_COMMAND="deploy $entry_commit $entry_run_id $sha_v1" \
  "$entrypoint" <"$archive_v1"
[[ -f "$incoming/blog-${entry_commit}-${entry_run_id}.tar.gz" ]]
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/${entry_commit}-${entry_run_id}" ]]
[[ ! -e "$test_root/injected-incoming" ]]
[[ ! -e "$test_root/injected-releases" ]]
[[ ! -e "$test_root/injected-current" ]]
[[ ! -e "$test_root/injected.lock" ]]
python3 - "$releases/${entry_commit}-${entry_run_id}" <<'PY'
import os
import stat
import sys

release = sys.argv[1]
expected_modes = {
    release: 0o755,
    os.path.join(release, "posts"): 0o755,
    os.path.join(release, "posts", "v1"): 0o755,
    os.path.join(release, "deployment.json"): 0o644,
    os.path.join(release, "index.html"): 0o644,
    os.path.join(release, "posts", "v1", "index.html"): 0o644,
}
for path, expected in expected_modes.items():
    mode = stat.S_IMODE(os.stat(path, follow_symlinks=False).st_mode)
    if mode != expected:
        raise SystemExit(
            f"{path} mode must be {expected:04o} after forced-command deploy, got {mode:04o}"
        )
PY
SSH_ORIGINAL_COMMAND="deploy $entry_commit $entry_run_id $sha_v1" \
  "$entrypoint" <"$archive_v1"
[[ "$(canonical_existing_path "$BLOG_CURRENT_LINK")" == "$releases/${entry_commit}-${entry_run_id}" ]]

printf 'PASS: static blog release scripts\n'
