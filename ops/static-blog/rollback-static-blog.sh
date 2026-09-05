#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib-static-blog.sh
source "$SCRIPT_DIR/lib-static-blog.sh"

usage() {
  cat >&2 <<'EOF'
Usage: rollback-static-blog.sh RELEASE_ID

RELEASE_ID must have commit-runId form, for example abc1234-123.
The target release is verified offline before the current symlink is changed.
EOF
  exit 2
}

[[ "$#" -eq 1 ]] || usage
require_command python3
require_command mv
require_command curl

release_id="$1"
validate_release_id "$release_id"
[[ -d "$BLOG_RELEASES_DIR" && ! -L "$BLOG_RELEASES_DIR" ]] \
  || die "releases directory must be a regular directory: $BLOG_RELEASES_DIR"
previous_target=""
rollback_armed=0

cleanup() {
  local exit_status="${1:-1}"
  set +e
  if [[ "${rollback_armed:-0}" -eq 1 ]]; then
    info "rollback interrupted after switch; restoring prior current release"
    (restore_previous_link "${previous_target:-}") || \
      printf 'ERROR: automatic prior-release restore failed\n' >&2
  fi
  release_deploy_lock
  return "$exit_status"
}
trap 'cleanup $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_deploy_lock

target_release="$BLOG_RELEASES_DIR/$release_id"
[[ -d "$target_release" && ! -L "$target_release" ]] \
  || die "rollback target does not exist or is not a regular directory: $target_release"
target_release="$(canonical_existing_path "$target_release")"
assert_path_within "$target_release" "$BLOG_RELEASES_DIR"

# This must complete before current_release_target/atomic_switch_link can mutate state.
"$SCRIPT_DIR/verify-static-blog.sh" "$target_release"

previous_target="$(current_release_target)"
if [[ "$previous_target" == "$target_release" ]]; then
  info "release $release_id is already current"
  exit 0
fi

rollback_armed=1
atomic_switch_link "$target_release"
if ! http_health_check_release "$target_release"; then
  info "rollback HTTP verification failed; restoring prior current release"
  restore_previous_link "$previous_target"
  rollback_armed=0
  die "rollback failed HTTP verification; prior current release restored"
fi
rollback_armed=0

info "rolled back to release $release_id"
info "current -> $target_release"
