#!/usr/bin/env python3
"""Deterministic regular-file archives and bounded extraction without tar links."""
import gzip
import hashlib
import json
import os
from pathlib import PurePosixPath
import shutil
import stat
import sys
import tarfile

MAX_BYTES = 900 * 1024 * 1024
MAX_FILES = 100000


def fail(message):
    raise ValueError(message)


def safe_name(raw):
    if not raw or any(char in raw for char in "\\\0\r\n:"):
        fail("unsafe archive member name")
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts:
        fail("archive path traversal rejected")
    return "/".join(part for part in path.parts if part not in ("", "."))


def digest(filename):
    value = hashlib.sha256()
    with open(filename, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def pack(root, destination, inventory_path):
    with open(inventory_path, encoding="utf8") as source:
        entries = json.load(source)
    with open(destination, "xb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for entry in entries:
                    name = safe_name(entry["path"])
                    filename = os.path.join(root, *name.split("/"))
                    mode = os.lstat(filename)
                    if not stat.S_ISREG(mode.st_mode) or mode.st_nlink != 1:
                        fail("release source must be a regular file without links")
                    if mode.st_size != entry["bytes"] or digest(filename) != entry["sha256"]:
                        fail("release source changed while packaging")
                    header = tarfile.TarInfo(name)
                    header.size = mode.st_size
                    header.mode = 0o644
                    header.mtime = 0
                    header.uid = header.gid = 0
                    header.uname = header.gname = ""
                    with open(filename, "rb") as contents:
                        archive.addfile(header, contents)


def extract(archive_path, destination, manifest_path=None):
    expected = None
    if manifest_path:
        with open(manifest_path, encoding="utf8") as source:
            manifest = json.load(source)
        expected = {entry["path"]: entry for entry in manifest["files"]}
    total = 0
    seen = set()
    members = []
    file_count = 0
    with tarfile.open(archive_path, mode="r:*") as archive:
        for member in archive:
            name = safe_name(member.name)
            if not name and member.isdir():
                continue
            if not name or name in seen:
                fail("empty or duplicate archive path")
            seen.add(name)
            if len(seen) > MAX_FILES * 2:
                fail("archive member limit exceeded")
            if not (member.isfile() or member.isdir()):
                fail("archive links and special files are forbidden")
            if member.isfile():
                total += member.size
                file_count += 1
                if total > MAX_BYTES or file_count > MAX_FILES:
                    fail("expanded archive limit exceeded")
                if expected is not None and (name not in expected or member.size != expected[name]["bytes"]):
                    fail("archive file does not match declared inventory")
            members.append((member, name))
        if expected is not None and {name for member, name in members if member.isfile()} != set(expected):
            fail("archive file inventory is incomplete")
        os.makedirs(destination, mode=0o755, exist_ok=False)
        for member, name in members:
            target = os.path.join(destination, *name.split("/"))
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            value = hashlib.sha256()
            source = archive.extractfile(member)
            with source, open(target, "xb") as output:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    value.update(chunk)
                    output.write(chunk)
            if expected is not None and value.hexdigest() != expected[name]["sha256"]:
                fail("archive file digest mismatch")
            os.chmod(target, 0o644)


if __name__ == "__main__":
    try:
        action, *arguments = sys.argv[1:]
        if action == "pack" and len(arguments) == 3:
            pack(*arguments)
        elif action == "extract" and len(arguments) == 3:
            extract(*arguments)
        elif action == "extract-pages" and len(arguments) == 2:
            extract(*arguments)
        else:
            fail("invalid archive operation")
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
