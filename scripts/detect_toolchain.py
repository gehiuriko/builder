#!/usr/bin/env python3
"""Detect an Android Gradle project and choose a fallback toolchain.

The Gradle wrapper always wins. The fallback table is only used when a ZIP omits
its wrapper, which is common with projects shared from phones/chat apps.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path


def set_output(key: str, value: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    line = f"{key}={value}\n"
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line)
    else:
        print(line, end="")


def version_tuple(v: str) -> tuple[int, ...]:
    nums = re.findall(r"\d+", v)
    return tuple(int(x) for x in nums[:3]) if nums else ()


def find_project_root(base: Path) -> Path:
    candidates: list[Path] = []
    for filename in ("settings.gradle", "settings.gradle.kts"):
        candidates.extend(base.rglob(filename))
    if not candidates:
        # Some minimal Android projects omit settings.gradle.
        for filename in ("build.gradle", "build.gradle.kts"):
            for p in base.rglob(filename):
                text = p.read_text(encoding="utf-8", errors="ignore")
                if "com.android.application" in text or "com.android.library" in text:
                    candidates.append(p)
    if not candidates:
        raise RuntimeError("No Android Gradle project root found")

    roots = [p.parent for p in candidates]
    # Prefer the shallowest project root, then alphabetical for determinism.
    roots.sort(key=lambda p: (len(p.relative_to(base).parts), str(p)))
    return roots[0]


def collect_gradle_text(root: Path) -> str:
    chunks: list[str] = []
    for name in ("build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"):
        p = root / name
        if p.exists():
            chunks.append(p.read_text(encoding="utf-8", errors="ignore"))
    # Version catalogs and buildSrc conventions can hide plugin versions; include common files.
    for p in (root / "gradle").glob("*.toml") if (root / "gradle").exists() else []:
        chunks.append(p.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(chunks)


def detect_agp(text: str) -> str:
    patterns = [
        r"com\.android\.application['\"]?\s+version\s+['\"]([^'\"]+)",
        r"com\.android\.library['\"]?\s+version\s+['\"]([^'\"]+)",
        r"id\s*\(?\s*['\"]com\.android\.application['\"]\s*\)?\s*version\s*['\"]([^'\"]+)",
        r"id\s*\(?\s*['\"]com\.android\.library['\"]\s*\)?\s*version\s*['\"]([^'\"]+)",
        r"com\.android\.tools\.build:gradle:([^'\"\s)]+)",
        r"androidGradlePlugin\s*=\s*['\"]([^'\"]+)",
        r"agp\s*=\s*['\"]([^'\"]+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.I)
        if m:
            return m.group(1).strip()
    return ""


def detect_compile_sdk(root: Path) -> str:
    for p in [root / "app" / "build.gradle", root / "app" / "build.gradle.kts"] + list(root.rglob("build.gradle*")):
        if not p.exists() or not p.is_file():
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        if "com.android.application" not in text and p.parent.name != "app":
            continue
        for pattern in (r"compileSdk(?:Version)?\s*[= ]\s*(\d+)", r"compileSdkVersion\s+(\d+)"):
            m = re.search(pattern, text)
            if m:
                return m.group(1)
    return ""


def fallback_gradle_for_agp(agp: str) -> str:
    """Known-safe minimum/recommended Gradle versions for common AGP releases.

    Keep this conservative. If a future/unknown AGP is encountered without a
    wrapper, fail loudly instead of guessing and producing confusing errors.
    """
    v = version_tuple(agp)
    if not v:
        return ""
    major, minor = (v + (0, 0))[:2]
    if major == 8:
        table = {
            0: "8.0",
            1: "8.0",
            2: "8.2",
            3: "8.4",
            4: "8.6",
            5: "8.7",
            6: "8.7",
            7: "8.9",
            8: "8.10.2",
            9: "8.11.1",
        }
        return table.get(minor, "")
    if major == 7:
        table = {0: "7.0.2", 1: "7.2", 2: "7.3.3", 3: "7.4", 4: "7.5"}
        return table.get(minor, "")
    if major == 4:
        return "6.7.1" if minor >= 2 else "6.5"
    return ""


def java_for_agp(agp: str) -> str:
    v = version_tuple(agp)
    if not v:
        return "17"
    if v[0] >= 8:
        return "17"
    if v[0] == 7:
        return "11"
    return "8"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: detect_toolchain.py <extracted-directory>")
    base = Path(sys.argv[1]).resolve()
    root = find_project_root(base)
    text = collect_gradle_text(root)
    agp = detect_agp(text)
    compile_sdk = detect_compile_sdk(root)
    wrapper = (root / "gradlew").exists() and (root / "gradle" / "wrapper" / "gradle-wrapper.properties").exists()

    wrapper_gradle = ""
    if wrapper:
        props = (root / "gradle" / "wrapper" / "gradle-wrapper.properties").read_text(encoding="utf-8", errors="ignore")
        m = re.search(r"gradle-([0-9][0-9A-Za-z.\-]*)-(?:bin|all)\.zip", props)
        if m:
            wrapper_gradle = m.group(1)

    fallback = fallback_gradle_for_agp(agp)
    if not wrapper and not fallback:
        raise RuntimeError(
            "Gradle wrapper is missing and the Android Gradle Plugin version could not be mapped safely. "
            f"Detected AGP: {agp or 'unknown'}. Add gradlew + gradle/wrapper to the project ZIP."
        )

    java = java_for_agp(agp)
    print("Android project detection")
    print(f"  root        : {root}")
    print(f"  AGP         : {agp or 'unknown'}")
    print(f"  wrapper     : {'yes' if wrapper else 'no'}")
    print(f"  Gradle      : {wrapper_gradle or fallback or 'wrapper'}")
    print(f"  JDK         : {java}")
    print(f"  compileSdk  : {compile_sdk or 'not detected'}")

    set_output("project_root", str(root))
    set_output("agp_version", agp)
    set_output("has_wrapper", "true" if wrapper else "false")
    set_output("gradle_version", wrapper_gradle or fallback)
    set_output("java_version", java)
    set_output("compile_sdk", compile_sdk)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
