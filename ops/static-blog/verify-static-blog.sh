#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib-static-blog.sh
source "$SCRIPT_DIR/lib-static-blog.sh"

usage() {
  cat >&2 <<'EOF'
Usage: verify-static-blog.sh RELEASE_DIRECTORY

Validates a static blog release without changing the current release symlink.
EOF
  exit 2
}

[[ "$#" -eq 1 ]] || usage
require_command python3

release_dir="$1"
[[ -d "$release_dir" && ! -L "$release_dir" ]] \
  || die "release directory must be a regular directory, not a symlink"
release_dir="$(canonical_existing_path "$release_dir")"

python3 - "$release_dir" <<'PY'
import json
import os
import re
import stat
import sys
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

root = os.path.realpath(sys.argv[1])
required_files = (
    "index.html",
    ".nojekyll",
    "content-manifest.json",
    "posts.json",
    "feed.xml",
    "sitemap.xml",
    "deployment.json",
)

def fail(message):
    raise SystemExit(message)

for current_root, directories, files in os.walk(root, topdown=True, followlinks=False):
    for name in directories + files:
        path = os.path.join(current_root, name)
        mode = os.lstat(path).st_mode
        if stat.S_ISLNK(mode):
            fail(f"symbolic links are not allowed in a release: {path}")
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            fail(f"special files are not allowed in a release: {path}")

for relative in required_files:
    path = os.path.join(root, relative)
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        fail(f"required file is missing: {relative}")
    if not stat.S_ISREG(mode):
        fail(f"required path is not a regular file: {relative}")

for relative in ("index.html", "content-manifest.json", "feed.xml", "sitemap.xml", "deployment.json"):
    if os.path.getsize(os.path.join(root, relative)) == 0:
        fail(f"required file is empty: {relative}")

try:
    with open(os.path.join(root, "deployment.json"), encoding="utf-8") as source:
        deployment = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError) as exc:
    fail(f"deployment.json is invalid: {exc}")

required_keys = {"repo", "commit", "runId", "siteUrl", "artifactSha256"}
if set(deployment) != required_keys:
    fail(f"deployment.json must contain exactly: {', '.join(sorted(required_keys))}")
if not isinstance(deployment["repo"], str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", deployment["repo"]):
    fail("deployment.json repo is invalid")
if not isinstance(deployment["commit"], str) or not re.fullmatch(r"[0-9a-f]{7,40}", deployment["commit"]):
    fail("deployment.json commit is invalid")
if not isinstance(deployment["runId"], str) or not re.fullmatch(r"[0-9]+", deployment["runId"]):
    fail("deployment.json runId is invalid")
if not isinstance(deployment["artifactSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", deployment["artifactSha256"]):
    fail("deployment.json artifactSha256 is invalid")
if not isinstance(deployment["siteUrl"], str):
    fail("deployment.json siteUrl is invalid")
site_url = deployment["siteUrl"]
parsed = urlsplit(site_url)
if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment or site_url.endswith("/"):
    fail("deployment.json siteUrl must be an HTTPS origin/path without query, fragment, or trailing slash")

try:
    with open(os.path.join(root, "content-manifest.json"), encoding="utf-8") as source:
        content_manifest = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError) as exc:
    fail(f"content-manifest.json is invalid: {exc}")
if not isinstance(content_manifest, (dict, list)):
    fail("content-manifest.json must contain a JSON object or array")
if not isinstance(content_manifest, dict):
    fail("content-manifest.json must contain a JSON object")
if content_manifest.get("source") != "notion":
    fail("content-manifest.json source must be notion")
if content_manifest.get("siteUrl") != site_url:
    fail("content-manifest.json siteUrl does not exactly match deployment.json siteUrl")

try:
    with open(os.path.join(root, "posts.json"), encoding="utf-8") as source:
        posts = json.load(source)
except (OSError, UnicodeError, json.JSONDecodeError) as exc:
    fail(f"posts.json is invalid: {exc}")
if not isinstance(posts, list) or not posts:
    fail("posts.json must contain at least one article")
first_path = posts[0].get("path") if isinstance(posts[0], dict) else None
if not isinstance(first_path, str) or not first_path:
    fail("the first posts.json article has no path")
first_posix = PurePosixPath(first_path)
if first_posix.is_absolute() or ".." in first_posix.parts or "\\" in first_path:
    fail("the first posts.json article path is unsafe")
article_relative = first_path.rstrip("/")
if not article_relative.endswith(".html"):
    article_relative += "/index.html"
article_path = os.path.join(root, *PurePosixPath(article_relative).parts)
if not os.path.isfile(article_path) or os.path.islink(article_path):
    fail(f"the first posts.json article page is missing: {article_relative}")

def read_text(relative):
    try:
        with open(os.path.join(root, relative), encoding="utf-8") as source:
            return source.read()
    except (OSError, UnicodeError) as exc:
        fail(f"{relative} is not valid UTF-8 text: {exc}")

index = read_text("index.html")
feed = read_text("feed.xml")
sitemap = read_text("sitemap.xml")
if not re.search(r"<link\b[^>]*\brel=[\"']canonical[\"'][^>]*>", index, re.IGNORECASE):
    fail("index.html has no canonical link")
if site_url not in index:
    fail("index.html canonical/site metadata does not contain siteUrl")
if site_url not in feed:
    fail("feed.xml does not contain siteUrl")
if site_url not in sitemap:
    fail("sitemap.xml does not contain siteUrl")
if not re.search(r"<(rss|feed)\b", feed, re.IGNORECASE):
    fail("feed.xml is not an RSS or Atom feed")
if not re.search(r"<(urlset|sitemapindex)\b", sitemap, re.IGNORECASE):
    fail("sitemap.xml is not a sitemap")

def local_asset_exists(reference, expected_suffix):
    parsed_ref = urlsplit(reference)
    if parsed_ref.scheme or parsed_ref.netloc or reference.startswith("//"):
        return False
    relative = unquote(parsed_ref.path).lstrip("/")
    posix = PurePosixPath(relative)
    if not relative or ".." in posix.parts or "\\" in relative:
        return False
    if not relative.lower().endswith(expected_suffix):
        return False
    candidate = os.path.join(root, *posix.parts)
    return os.path.isfile(candidate) and not os.path.islink(candidate)

stylesheet_refs = re.findall(
    r"<link\b(?=[^>]*\brel=[\"']stylesheet[\"'])[^>]*\bhref=[\"']([^\"']+)[\"']",
    index,
    re.IGNORECASE,
)
script_refs = re.findall(r"<script\b[^>]*\bsrc=[\"']([^\"']+)[\"']", index, re.IGNORECASE)
if not any(local_asset_exists(reference, ".css") for reference in stylesheet_refs):
    fail("index.html has no existing local CSS reference")
if not any(local_asset_exists(reference, ".js") for reference in script_refs):
    fail("index.html has no existing local JavaScript reference")

print(
    "verified release "
    f"{deployment['commit']}-{deployment['runId']} "
    f"for {deployment['siteUrl']}"
)
PY
