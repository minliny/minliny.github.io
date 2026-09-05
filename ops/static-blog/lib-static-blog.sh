#!/usr/bin/env bash

# Shared primitives for the static blog release scripts.
# This file is sourced by the entry-point scripts, which enable strict mode.

BLOG_INCOMING_DIR="${BLOG_INCOMING_DIR:-/opt/releases/blog/.incoming}"
BLOG_RELEASES_DIR="${BLOG_RELEASES_DIR:-/opt/releases/blog}"
BLOG_CURRENT_LINK="${BLOG_CURRENT_LINK:-/srv/blog/current}"
BLOG_LOCAL_ORIGIN="${BLOG_LOCAL_ORIGIN:-http://127.0.0.1:8080}"
BLOG_HTTP_HOST="${BLOG_HTTP_HOST:-blog.minliny.com}"
BLOG_CURL_RESOLVE="${BLOG_CURL_RESOLVE-}"
BLOG_CURL_CA_CERT="${BLOG_CURL_CA_CERT:-}"
BLOG_HEALTH_ATTEMPTS="${BLOG_HEALTH_ATTEMPTS:-10}"
BLOG_HEALTH_INTERVAL_SECONDS="${BLOG_HEALTH_INTERVAL_SECONDS:-1}"
BLOG_MAX_UNPACKED_BYTES="${BLOG_MAX_UNPACKED_BYTES:-1073741824}"
BLOG_MAX_FILES="${BLOG_MAX_FILES:-100000}"
BLOG_ALLOW_MKDIR_LOCK_FALLBACK="${BLOG_ALLOW_MKDIR_LOCK_FALLBACK:-0}"

BLOG_LOCK_METHOD=""
BLOG_LOCK_DIRECTORY=""

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

acquire_deploy_lock() {
  local lock_file="${BLOG_LOCK_FILE:-$BLOG_RELEASES_DIR/.deploy.lock}"
  [[ "$lock_file" != *$'\n'* && "$lock_file" != *$'\r'* ]] \
    || die "BLOG_LOCK_FILE contains a newline"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_file"
    flock -n 9 || die "another deploy or rollback holds the lock: $lock_file"
    BLOG_LOCK_METHOD="flock"
    return 0
  fi
  if [[ "$BLOG_ALLOW_MKDIR_LOCK_FALLBACK" == "1" ]]; then
    BLOG_LOCK_DIRECTORY="${lock_file}.d"
    mkdir -- "$BLOG_LOCK_DIRECTORY" 2>/dev/null \
      || die "another deploy or rollback holds the fallback lock: $BLOG_LOCK_DIRECTORY"
    BLOG_LOCK_METHOD="mkdir"
    return 0
  fi
  die "flock is required (mkdir fallback is reserved for the portable self-test)"
}

release_deploy_lock() {
  if [[ "$BLOG_LOCK_METHOD" == "flock" ]]; then
    flock -u 9 >/dev/null 2>&1 || true
    exec 9>&-
  elif [[ "$BLOG_LOCK_METHOD" == "mkdir" && -n "$BLOG_LOCK_DIRECTORY" ]]; then
    rmdir -- "$BLOG_LOCK_DIRECTORY" >/dev/null 2>&1 || true
  fi
  BLOG_LOCK_METHOD=""
  BLOG_LOCK_DIRECTORY=""
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$file" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum is available"
  fi
}

canonical_existing_path() {
  python3 - "$1" <<'PY'
import os
import sys

path = sys.argv[1]
if not os.path.exists(path):
    raise SystemExit(f"path does not exist: {path}")
print(os.path.realpath(path))
PY
}

assert_path_within() {
  local path="$1"
  local parent="$2"
  python3 - "$path" "$parent" <<'PY'
import os
import sys

path = os.path.realpath(sys.argv[1])
parent = os.path.realpath(sys.argv[2])
try:
    inside = os.path.commonpath((path, parent)) == parent
except ValueError:
    inside = False
if not inside:
    raise SystemExit(f"path escapes allowed directory: {path} (allowed: {parent})")
PY
}

validate_release_fields() {
  local repo="$1"
  local commit="$2"
  local run_id="$3"
  local site_url="$4"
  local artifact_sha256="$5"

  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
    || die "repo must have owner/name form"
  [[ "$commit" =~ ^[0-9a-fA-F]{7,40}$ ]] \
    || die "commit must be a 7-40 character hexadecimal Git commit"
  [[ "$run_id" =~ ^[0-9]+$ ]] \
    || die "runId must contain digits only"
  [[ "$site_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^[:space:]]*)?$ ]] \
    || die "siteUrl must be an HTTPS URL without whitespace"
  [[ "$site_url" != */ ]] \
    || die "siteUrl must not end with a slash"
  [[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || die "artifactSha256 must be a lowercase 64-character SHA-256 value"
}

validate_release_id() {
  local release_id="$1"
  [[ "$release_id" =~ ^[0-9a-fA-F]{7,40}-[0-9]+$ ]] \
    || die "release id must have commit-runId form"
}

assert_archive_safe_and_extract() {
  local archive="$1"
  local destination="$2"

  python3 - "$archive" "$destination" "$BLOG_MAX_UNPACKED_BYTES" "$BLOG_MAX_FILES" <<'PY'
import os
from pathlib import PurePosixPath
import shutil
import stat
import sys
import tarfile

archive, destination, max_bytes_text, max_files_text = sys.argv[1:]
max_bytes = int(max_bytes_text)
max_files = int(max_files_text)

def fail(message):
    raise SystemExit(message)

if os.path.islink(archive) or not os.path.isfile(archive):
    fail("artifact archive must be a regular file, not a symlink")

seen = set()
total_bytes = 0
file_count = 0
validated = []

try:
    tar = tarfile.open(archive, mode="r:gz")
except (tarfile.TarError, OSError) as exc:
    fail(f"invalid gzip tar artifact: {exc}")

with tar:
    for member in tar.getmembers():
        raw_name = member.name
        if not raw_name or "\\" in raw_name or "\x00" in raw_name or "\n" in raw_name or "\r" in raw_name:
            fail(f"unsafe archive member name: {raw_name!r}")
        path = PurePosixPath(raw_name)
        if path.is_absolute() or ".." in path.parts:
            fail(f"archive path traversal rejected: {raw_name!r}")
        parts = [part for part in path.parts if part not in ("", ".")]
        normalized = "/".join(parts)
        if not normalized:
            if member.isdir():
                continue
            fail(f"unsafe archive member name: {raw_name!r}")
        if normalized in seen:
            fail(f"duplicate archive member rejected: {normalized!r}")
        seen.add(normalized)
        if member.issym() or member.islnk():
            fail(f"archive links are not allowed: {raw_name!r}")
        if not (member.isdir() or member.isfile()):
            fail(f"special archive member is not allowed: {raw_name!r}")
        if member.isfile():
            file_count += 1
            total_bytes += member.size
            if file_count > max_files:
                fail(f"artifact contains more than {max_files} files")
            if total_bytes > max_bytes:
                fail(f"artifact expands beyond {max_bytes} bytes")
        validated.append((member, normalized))

    os.makedirs(destination, mode=0o755, exist_ok=False)
    destination_real = os.path.realpath(destination)

    for member, normalized in validated:
        target = os.path.join(destination, *normalized.split("/"))
        parent = target if member.isdir() else os.path.dirname(target)
        parent_real = os.path.realpath(parent)
        if os.path.commonpath((parent_real, destination_real)) != destination_real:
            fail(f"archive member escapes extraction directory: {member.name!r}")
        if member.isdir():
            os.makedirs(target, exist_ok=True)
            os.chmod(target, member.mode & 0o755)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        source = tar.extractfile(member)
        if source is None:
            fail(f"cannot read archive member: {member.name!r}")
        with source, open(target, "xb") as output:
            shutil.copyfileobj(source, output)
        os.chmod(target, member.mode & 0o755)
PY
}

write_deployment_json() {
  local destination="$1"
  local repo="$2"
  local commit="$3"
  local run_id="$4"
  local site_url="$5"
  local artifact_sha256="$6"

  python3 - "$destination" "$repo" "$commit" "$run_id" "$site_url" "$artifact_sha256" <<'PY'
import json
import os
import sys

destination, repo, commit, run_id, site_url, artifact_sha256 = sys.argv[1:]
payload = {
    "repo": repo,
    "commit": commit.lower(),
    "runId": run_id,
    "siteUrl": site_url,
    "artifactSha256": artifact_sha256,
}
temporary = destination + ".tmp"
with open(temporary, "w", encoding="utf-8", newline="\n") as output:
    json.dump(payload, output, ensure_ascii=False, indent=2, sort_keys=True)
    output.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, destination)
PY
}

deployment_json_matches() {
  local release_dir="$1"
  local repo="$2"
  local commit="$3"
  local run_id="$4"
  local site_url="$5"
  local artifact_sha256="$6"

  python3 - \
    "$release_dir/deployment.json" \
    "$repo" "$commit" "$run_id" "$site_url" "$artifact_sha256" <<'PY'
import json
import sys

path, repo, commit, run_id, site_url, artifact_sha256 = sys.argv[1:]
expected = {
    "repo": repo,
    "commit": commit,
    "runId": run_id,
    "siteUrl": site_url,
    "artifactSha256": artifact_sha256,
}
try:
    with open(path, encoding="utf-8") as source:
        actual = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError) as exc:
    raise SystemExit(f"cannot read existing deployment identity: {exc}")
if actual != expected:
    raise SystemExit("existing release identity does not match requested deployment")
PY
}

current_release_target() {
  if [[ ! -e "$BLOG_CURRENT_LINK" && ! -L "$BLOG_CURRENT_LINK" ]]; then
    return 0
  fi
  [[ -L "$BLOG_CURRENT_LINK" ]] \
    || die "current path exists but is not a symbolic link: $BLOG_CURRENT_LINK"
  local target
  target="$(canonical_existing_path "$BLOG_CURRENT_LINK")" \
    || die "current symbolic link is broken: $BLOG_CURRENT_LINK"
  assert_path_within "$target" "$BLOG_RELEASES_DIR" \
    || die "current symbolic link points outside releases directory"
  printf '%s\n' "$target"
}

atomic_switch_link() {
  local target="$1"
  local current_parent
  local temporary_link

  [[ -d "$target" && ! -L "$target" ]] \
    || die "release target is not a regular directory: $target"
  assert_path_within "$target" "$BLOG_RELEASES_DIR"
  current_parent="$(dirname "$BLOG_CURRENT_LINK")"
  [[ -d "$current_parent" && ! -L "$current_parent" ]] \
    || die "current link parent must be a regular directory: $current_parent"
  if [[ -e "$BLOG_CURRENT_LINK" && ! -L "$BLOG_CURRENT_LINK" ]]; then
    die "refusing to replace non-symlink current path: $BLOG_CURRENT_LINK"
  fi

  temporary_link="${BLOG_CURRENT_LINK}.next.$$"
  [[ ! -e "$temporary_link" && ! -L "$temporary_link" ]] \
    || die "temporary link already exists: $temporary_link"
  ln -s "$target" "$temporary_link"

  # GNU mv performs the desired atomic rename directly. macOS/BSD mv has no -T,
  # so the self-test uses os.replace(), which maps to the same rename operation.
  if mv -Tf "$temporary_link" "$BLOG_CURRENT_LINK" 2>/dev/null; then
    return 0
  fi
  python3 - "$temporary_link" "$BLOG_CURRENT_LINK" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

restore_previous_link() {
  local previous_target="$1"
  if [[ -n "$previous_target" ]]; then
    atomic_switch_link "$previous_target"
  else
    [[ -L "$BLOG_CURRENT_LINK" ]] && rm -f -- "$BLOG_CURRENT_LINK"
  fi
}

http_health_check_release() {
  local release_dir="$1"
  local attempt
  local curl_args
  local response_dir
  local relative_path

  require_command curl
  [[ "$BLOG_HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] \
    || die "BLOG_HEALTH_ATTEMPTS must be a positive integer"
  [[ "$BLOG_HEALTH_INTERVAL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] \
    || die "BLOG_HEALTH_INTERVAL_SECONDS must be a non-negative number"
  [[ "$BLOG_HTTP_HOST" != *$'\n'* && "$BLOG_HTTP_HOST" != *$'\r'* ]] \
    || die "BLOG_HTTP_HOST contains a newline"

  response_dir="$(mktemp -d "${TMPDIR:-/tmp}/blog-health.XXXXXX")"
  curl_args=(--fail --silent --show-error --connect-timeout 5 --max-time 15)
  if [[ -n "$BLOG_HTTP_HOST" ]]; then
    curl_args+=(--header "Host: $BLOG_HTTP_HOST")
  fi
  if [[ -n "$BLOG_CURL_RESOLVE" ]]; then
    curl_args+=(--resolve "$BLOG_CURL_RESOLVE")
  fi
  if [[ -n "$BLOG_CURL_CA_CERT" ]]; then
    [[ -f "$BLOG_CURL_CA_CERT" && ! -L "$BLOG_CURL_CA_CERT" ]] \
      || die "BLOG_CURL_CA_CERT must be a regular file"
    curl_args+=(--cacert "$BLOG_CURL_CA_CERT")
  fi
  for ((attempt = 1; attempt <= BLOG_HEALTH_ATTEMPTS; attempt++)); do
    local healthy=1
    rm -f -- "$response_dir"/*
    for relative_path in deployment.json index.html content-manifest.json feed.xml sitemap.xml; do
      if ! curl "${curl_args[@]}" \
        --output "$response_dir/$(basename "$relative_path")" \
        "${BLOG_LOCAL_ORIGIN%/}/${relative_path}"; then
        healthy=0
        break
      fi
      if [[ "$(sha256_file "$response_dir/$(basename "$relative_path")")" \
          != "$(sha256_file "$release_dir/$relative_path")" ]]; then
        healthy=0
        break
      fi
    done
    if [[ "$healthy" -eq 1 ]]; then
      rm -rf -- "$response_dir"
      return 0
    fi
    if [[ "$attempt" -lt "$BLOG_HEALTH_ATTEMPTS" ]]; then
      sleep "$BLOG_HEALTH_INTERVAL_SECONDS"
    fi
  done

  rm -rf -- "$response_dir"
  return 1
}
