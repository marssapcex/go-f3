#!/usr/bin/env python3
"""Build audit/report/WHITEPAPER.md from WHITEPAPER.src.md.

Directives (each on its own line in the .src.md file). Paths are relative to diamondtrading/.

  <<CODE path|start|end|lang>>     fenced code, lines start..end (1-based, inclusive)
  <<TEST path|title-substring>>    the whole it("...") block from the test file
  <<LOG path|title-substring>>     mocha output that belongs to one test (from a per-file log)
  <<DIFFSTAT>>                     git diff --stat of the fix against commit 3cb964b
  <<MANIFEST>>                     SHA-256 of evidence, tests, contracts and the diff

The script fails loudly if a directive cannot be resolved, so the report never silently
contains a missing or stale snippet.
"""
import hashlib
import pathlib
import re
import subprocess
import sys

DT = pathlib.Path(__file__).resolve().parents[2]          # .../diamondtrading
REPO = DT.parent                                           # repo root
BASE = "3cb964b"
SRC = DT / "audit/report/WHITEPAPER.src.md"
OUT = DT / "audit/report/WHITEPAPER.md"
DIFF = DT / "audit/report/fixes.diff"
PATHS_FOR_FIX = ["diamondtrading/contracts", "diamondtrading/engine",
                 "diamondtrading/scripts", "diamondtrading/README.md"]

DIRECTIVE = re.compile(r"^<<(CODE|TEST|LOG|DIFFSTAT|MANIFEST)(?:\s+(.*?))?>>\s*$")


def read(rel):
    p = DT / rel
    if not p.exists():
        sys.exit(f"[build] missing file: {rel}")
    return p.read_text(encoding="utf-8").splitlines()


def block(lang, lines):
    return [f"```{lang}"] + lines + ["```"]


def do_code(arg):
    path, start, end, lang = arg.split("|")
    lines = read(path)
    s, e = int(start), int(end)
    if not (1 <= s <= e <= len(lines)):
        sys.exit(f"[build] CODE range out of bounds: {path} {s}-{e} (file has {len(lines)} lines)")
    return [f"*`{path}` · dòng {s}–{e}*", ""] + block(lang, lines[s - 1:e]) + [""]


def do_test(arg):
    path, title = arg.split("|", 1)
    lines = read(path)
    hits = [i for i, l in enumerate(lines) if re.search(r"^\s*it\(", l) and title in l]
    if len(hits) != 1:
        sys.exit(f"[build] TEST title matched {len(hits)} times in {path}: {title!r}")
    i = hits[0]
    j = next((k for k in range(i + 1, len(lines)) if lines[k].rstrip() == "  });"), None)
    if j is None:
        sys.exit(f"[build] TEST block end not found in {path}: {title!r}")
    return [f"*`{path}` · dòng {i + 1}–{j + 1}*", ""] + block("javascript", lines[i:j + 1]) + [""]


def do_log(arg):
    path, title = arg.split("|", 1)
    lines = read(path)
    marks = [i for i, l in enumerate(lines)
             if title in l and (l.lstrip().startswith("✔") or l.lstrip().startswith("- "))]
    if len(marks) != 1:
        sys.exit(f"[build] LOG title matched {len(marks)} times in {path}: {title!r}")
    end = marks[0]
    start = end - 1
    while start >= 0:
        s = lines[start]
        if re.match(r"^\s{4}(✔|- )", s) or re.match(r"^\s{2}\S", s) and not s.startswith("  ["):
            break
        start -= 1
    body = [l for l in lines[start + 1:end + 1] if l.strip()]
    tag = pathlib.Path(path).name
    return [f"*`{tag}`*", ""] + block("text", body) + [""]


def regenerate_fix_diff():
    out = subprocess.run(["git", "diff", BASE, "--", *PATHS_FOR_FIX], cwd=REPO,
                         capture_output=True, text=True, check=True).stdout
    DIFF.write_text(out, encoding="utf-8")
    return out


def do_diffstat():
    out = subprocess.run(["git", "diff", "--stat", BASE, "--", *PATHS_FOR_FIX], cwd=REPO,
                         capture_output=True, text=True, check=True).stdout
    return block("text", out.rstrip().splitlines()) + [""]


def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def do_manifest():
    files = []
    files += sorted((DT / "audit/evidence").glob("*.txt"))
    files += sorted((DT / "audit/evidence/per-file").glob("*.txt"))
    files += sorted((DT / "audit/test").glob("*.js"))
    files += sorted((DT / "audit/vulnerable/contracts").glob("*.sol"))
    files += sorted((DT / "audit/vulnerable/engine").glob("*.js"))
    files += sorted((DT / "audit/vulnerable/scripts").glob("*.js"))
    files += sorted((DT / "contracts").glob("*.sol"))
    files += [DT / "engine/ledger.js", DT / "engine/quoter.js", DT / "scripts/deploy.js", DIFF]
    rows = ["| SHA-256 | Bytes | File |", "|---|---:|---|"]
    for f in files:
        if f.is_file():
            rows.append(f"| `{sha256(f)}` | {f.stat().st_size} | `{f.relative_to(DT)}` |")
    return rows + [""]


def main():
    diff = regenerate_fix_diff()
    out = []
    for raw in SRC.read_text(encoding="utf-8").splitlines():
        m = DIRECTIVE.match(raw)
        if not m:
            out.append(raw)
            continue
        kind, arg = m.group(1), (m.group(2) or "")
        if kind == "CODE":
            out += do_code(arg)
        elif kind == "TEST":
            out += do_test(arg)
        elif kind == "LOG":
            out += do_log(arg)
        elif kind == "DIFFSTAT":
            out += do_diffstat()
        elif kind == "MANIFEST":
            out += do_manifest()
    if "<<" in "\n".join(out):
        leftover = [l for l in out if l.startswith("<<")]
        sys.exit(f"[build] unresolved directives: {leftover[:3]}")
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"[build] wrote {OUT.relative_to(REPO)} ({len(out)} lines); fixes.diff {len(diff.splitlines())} lines")


if __name__ == "__main__":
    main()
