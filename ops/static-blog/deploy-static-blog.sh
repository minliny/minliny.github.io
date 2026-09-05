#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib-static-blog.sh
source "$SCRIPT_DIR/lib-static-blog.sh"

usage() {
  cat >&2 <<'EOF'
Usage: deploy-static-blog.sh ARTIFACT_TAR_GZ SHA256 REPO COMMIT RUN_ID SITE_URL

Example:
  deploy-static-blog.sh \
    /opt/releases/blog/.incoming/blog-abc1234-123.tar.gz \
    0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    minliny/minliny.github.io abc1234 123 https://blog.minliny.com

The archive must live below BLOG_INCOMING_DIR (default: /opt/releases/blog/.incoming).
EOF
  exit 2
}

[[ "$#" -eq 6 ]] || usage
require_command python3
require_command cp
require_command mv
require_command curl

artifact="$1"
expected_sha256="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
repo="$3"
commit="$(printf '%s' "$4" | tr '[:upper:]' '[:lower:]')"
run_id="$5"
site_url="$6"

validate_release_fields "$repo" "$commit" "$run_id" "$site_url" "$expected_sha256"
[[ -d "$BLOG_INCOMING_DIR" && ! -L "$BLOG_INCOMING_DIR" ]] \
  || die "incoming directory must be a regular directory: $BLOG_INCOMING_DIR"
[[ -d "$BLOG_RELEASES_DIR" && ! -L "$BLOG_RELEASES_DIR" ]] \
  || die "releases directory must be a regular directory: $BLOG_RELEASES_DIR"
[[ -f "$artifact" && ! -L "$artifact" ]] \
  || die "artifact must be a regular file, not a symlink"

artifact="$(canonical_existing_path "$artifact")"
assert_path_within "$artifact" "$BLOG_INCOMING_DIR"
actual_sha256="$(sha256_file "$artifact")"
[[ "$actual_sha256" == "$expected_sha256" ]] \
  || die "artifact SHA-256 mismatch: expected $expected_sha256, got $actual_sha256"

release_id="${commit}-${run_id}"
validate_release_id "$release_id"
final_release="$BLOG_RELEASES_DIR/$release_id"
staging_release="$BLOG_RELEASES_DIR/.${release_id}.staging.$$"
source_parent="$(mktemp -d "${TMPDIR:-/tmp}/blog-artifact.XXXXXX")"
source_dir="$source_parent/source"
previous_target=""
rollback_armed=0

cleanup() {
  local exit_status="${1:-1}"
  set +e
  if [[ "${rollback_armed:-0}" -eq 1 ]]; then
    info "deployment interrupted after switch; restoring previous release"
    (restore_previous_link "${previous_target:-}") || \
      printf 'ERROR: automatic previous-release restore failed\n' >&2
  fi
  rm -rf -- "$source_parent"
  if [[ -n "${staging_release:-}" && -d "$staging_release" ]]; then
    rm -rf -- "$staging_release"
  fi
  if [[ -n "${temporary_link:-}" && -L "$temporary_link" ]]; then
    rm -f -- "$temporary_link"
  fi
  release_deploy_lock
  return "$exit_status"
}
trap 'cleanup $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_deploy_lock

activate_release() {
  local target_release="$1"
  local current_target
  target_release="$(canonical_existing_path "$target_release")"
  previous_target="$(current_release_target)"
  current_target="$previous_target"

  if [[ "$current_target" != "$target_release" ]]; then
    rollback_armed=1
    atomic_switch_link "$target_release"
  fi
  if ! http_health_check_release "$target_release"; then
    if [[ "$rollback_armed" -eq 1 ]]; then
      info "post-switch HTTP verification failed; restoring previous release"
      restore_previous_link "$previous_target"
      rollback_armed=0
      die "deployment failed HTTP verification; previous release restored"
    fi
    die "current release failed HTTP verification"
  fi
  rollback_armed=0
}

if [[ -e "$final_release" || -L "$final_release" ]]; then
  [[ -d "$final_release" && ! -L "$final_release" ]] \
    || die "release id exists but is not a regular directory: $final_release"
  deployment_json_matches \
    "$final_release" "$repo" "$commit" "$run_id" "$site_url" "$expected_sha256"
  "$SCRIPT_DIR/verify-static-blog.sh" "$final_release"
  activate_release "$final_release"
  info "deployment already present and verified: $release_id"
  info "current -> $(canonical_existing_path "$final_release")"
  exit 0
fi
[[ ! -e "$staging_release" && ! -L "$staging_release" ]] \
  || die "staging path already exists: $staging_release"

assert_archive_safe_and_extract "$artifact" "$source_dir"
[[ ! -e "$source_dir/deployment.json" && ! -L "$source_dir/deployment.json" ]] \
  || die "artifact must not provide deployment.json; the deployer owns it"

mkdir -m 0755 -- "$staging_release"
# The '/.' form is intentional: it preserves .nojekyll and any other dotfiles.
cp -a "$source_dir/." "$staging_release/"
write_deployment_json \
  "$staging_release/deployment.json" \
  "$repo" "$commit" "$run_id" "$site_url" "$expected_sha256"

"$SCRIPT_DIR/verify-static-blog.sh" "$staging_release"
mv -- "$staging_release" "$final_release"
staging_release=""

activate_release "$final_release"

info "deployed release $release_id"
info "current -> $(canonical_existing_path "$final_release")"
