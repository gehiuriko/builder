#!/usr/bin/env python3
import os
import sys
import zipfile
from pathlib import Path


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: safe_extract.py <project.zip> <destination>")

    zip_path = Path(sys.argv[1]).resolve()
    dest = Path(sys.argv[2]).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    if not zipfile.is_zipfile(zip_path):
        fail("uploaded file is not a valid ZIP archive")

    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        if len(infos) > 100_000:
            fail("ZIP contains too many files")

        total_uncompressed = sum(i.file_size for i in infos)
        # Generous safety cap: 8 GiB unpacked. This prevents obvious ZIP bombs.
        if total_uncompressed > 8 * 1024**3:
            fail("ZIP expands beyond the 8 GiB safety limit")

        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.startswith("/"):
                fail(f"unsafe absolute path in ZIP: {name}")
            target = (dest / name).resolve()
            try:
                target.relative_to(dest)
            except ValueError:
                fail(f"unsafe parent traversal in ZIP: {name}")

            # Reject Unix symlinks from archives. Build projects should contain real files.
            mode = (info.external_attr >> 16) & 0xFFFF
            if (mode & 0o170000) == 0o120000:
                fail(f"symlink entries are not allowed: {name}")

        zf.extractall(dest)

    print(f"Extracted {len(infos)} entries to {dest}")


if __name__ == "__main__":
    main()
