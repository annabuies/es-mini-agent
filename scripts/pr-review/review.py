#!/usr/bin/env python3
"""Staff-engineer AI PR review for es-mini-agent (ported from es-os-app).

Pulls the PR diff via gh, attaches budgeted full-file context for changed
files (skipping lockfiles / generated / fixtures), asks Claude Sonnet for a
review, posts or updates a PR comment, and exits 1 if any Must Fix remains.

Secrets are read from the environment only. This script never prints or
commits key values.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

COMMENT_MARKER = "<!-- es-mini-agent-ai-pr-review -->"
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
MAX_TOKENS = 8192

MAX_DIFF_CHARS = 350_000
MAX_FILE_CHARS = 80_000
MAX_TOTAL_FILE_CHARS = 350_000

# The workflow runs this script from a checkout of the default branch (so a PR
# cannot rewrite its own reviewer) and points REVIEW_REPO_ROOT at the PR head.
REPO_ROOT = Path(os.environ.get("REVIEW_REPO_ROOT") or Path(__file__).resolve().parents[2])

FULL_CONTENT_EXCLUDE_NAMES = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "npm-shrinkwrap.json",
        "composer.lock",
        "Gemfile.lock",
        "Cargo.lock",
        "poetry.lock",
        "go.sum",
        "Podfile.lock",
        "Package.resolved",
        "gradle-wrapper.jar",
    }
)
FULL_CONTENT_EXCLUDE_SUFFIXES = (
    ".min.js",
    ".min.css",
    ".map",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svg",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp4",
    ".mov",
    ".pdf",
    ".zip",
    ".gz",
    ".tgz",
    ".bin",
    ".lock",
)
FULL_CONTENT_EXCLUDE_DIR_PARTS = frozenset(
    {
        "node_modules",
        "www",
        "dist",
        "build",
        "coverage",
        "fixtures",
        "testdata",
        "golden",
        "generated",
        "vendor",
        "__snapshots__",
        "pods",
        ".gradle",
        ".wrangler",
    }
)
FULL_CONTENT_EXCLUDE_NAME_HINTS = (
    "fixture",
    "generated",
    "snap",
)

HUMAN_REVIEW_PATH_RE = re.compile(
    r"""(?ix)
    (^|/)(
        install\.sh |
        uninstall\.sh |
        self-update\.js |
        modules\.txt |
        server\.js |
        power\.js |
        aws-creds\.js |
        storage-upload\.js |
        r2-upload\.js |
        digest-auth\.js |
        com\.es\.[a-z-]+\.plist |
        \.github/
    )
    """
)
HUMAN_REVIEW_KEYWORD_RE = re.compile(
    r"""(?ix)
    (
        RECORD_CONTROL |
        POWER_STRIP |
        POWER_OUTLETS |
        AWS_SECRET |
        AWS_ACCESS |
        R2_ |
        PTZ_HTTP_PASS |
        OBS_PASSWORD |
        launchctl |
        AGENT_VERSION
    )
    """
)

SYSTEM_PROMPT = """\
You are a staff engineer reviewing a pull request for es-mini-agent, the
agent that runs unattended on the EVRYBDY Studios Mac Mini (bench-1). It is a
zero-dependency Node service under launchd: record control for OBS, uploads
to S3/R2, camera reachability and PTZ, Pro 10 power strip (lights only), and
a heartbeat. main is LIVE: the Mini self-updates from main (only *.js files
listed in modules.txt), and people run install.sh straight from main via curl.
Nobody can easily SSH in, so a crash-loop or a broken installer strands the
studio.

Persona: precise, skeptical, production-minded. Prefer fewer findings.
Use the attached FULL FILE contents, not just the diff, before calling
something a Must Fix. If the surrounding file already handles the case,
do not file Must Fix.

## Verdict rules
Must Fix is only for real merge blockers:
- Secret or key leakage: RECORD_CONTROL_KEY, AWS/R2 keys, power strip or
  camera passwords, OBS password, anything from the launchd plist, committed
  or logged or sent in a heartbeat
- Unauthenticated or weakened access to record control, power, PTZ, diag or
  fetch_docs ops; any path that lets a remote caller switch off the router,
  PoE switch, Mini or NAS outlets (only the lights outlet may switch)
- Self-update hazards: modules.txt listing a non-.js file or a module that
  does not exist, a new require() of a file not in modules.txt, anything that
  would make the updated agent crash-loop on boot
- install.sh wiping or failing to reuse existing plist values, writing into
  ~/Documents from a launchd-started shell script (macOS folder privacy blocks
  it), or breaking bash 3.2 (macOS /bin/bash)
- Recording loss: stopping, deleting or overwriting footage, uploads marked
  done without a confirmed upload, retries that drop files
- Workflow changes that expose repository secrets to PR code
- An obvious production outage

Not Must Fix (use Should Fix or Notes):
- Style, naming, extra tests, refactors, copy nits
- Speculative issues contradicted by full-file context
- Pre-existing problems the PR does not make worse

## Human-merge surfaces
Anna merges every PR. Say explicitly when the diff touches the installer,
self-update, modules.txt, secrets, power, record control or the workflow.

## Output format (exact)
First lines:
VERDICT: PASS
or
VERDICT: MUST_FIX
CLASS: A|B|C
SUMMARY: one line

CLASS meaning (informational only; this action never merges):
- A: docs/chore/test-only
- B: agent behaviour change a human should glance at
- C: installer, self-update, secrets, power, record control or workflow

Then markdown sections:
## Must Fix
- concrete items with file paths, or the single word None

## Should Fix
- optional, or None

## Notes
- human-merge reminder when CLASS is C; otherwise brief context
"""


def normalize_repo_path(path: str) -> str:
    rel = str(path or "").replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    return rel.lstrip("/")


def path_dir_parts(path: str) -> set[str]:
    return {part.lower() for part in normalize_repo_path(path).split("/") if part}


def exclude_full_content(path: str) -> bool:
    """Lockfiles, generated trees, fixtures, and binaries skip full-file attach."""
    rel = normalize_repo_path(path)
    if not rel:
        return True
    name = Path(rel).name
    if name in FULL_CONTENT_EXCLUDE_NAMES:
        return True
    lower_name = name.lower()
    if any(hint in lower_name for hint in FULL_CONTENT_EXCLUDE_NAME_HINTS):
        return True
    if lower_name.endswith(FULL_CONTENT_EXCLUDE_SUFFIXES):
        return True
    parts = path_dir_parts(rel)
    if parts & FULL_CONTENT_EXCLUDE_DIR_PARTS:
        return True
    return False


def needs_human_review(paths: list[str], extra_text: str = "") -> bool:
    blob = "\n".join(paths) + "\n" + (extra_text or "")
    if HUMAN_REVIEW_KEYWORD_RE.search(blob):
        return True
    return any(HUMAN_REVIEW_PATH_RE.search(normalize_repo_path(p)) for p in paths)


def extract_section(text: str, heading: str) -> str:
    pattern = re.compile(
        rf"^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s+|\Z)",
        re.I | re.M | re.S,
    )
    match = pattern.search(text or "")
    return (match.group(1) if match else "").strip()


def section_has_items(section: str) -> bool:
    if not section:
        return False
    compact = re.sub(r"\s+", " ", section).strip().lower()
    if compact in {"none", "- none", "* none", "n/a", "no must fix", "none."}:
        return False
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if re.fullmatch(r"[-*]\s*(none|n/a)\.?", stripped, re.I):
            continue
        if stripped.startswith(("-", "*", "1.", "•")):
            return True
        if re.match(r"^\d+\.", stripped):
            return True
    return False


def parse_verdict(text: str) -> str:
    match = re.search(r"^VERDICT:\s*(PASS|MUST_FIX|MUST FIX|FAIL)\s*$", text or "", re.I | re.M)
    if match:
        token = re.sub(r"\s+", "_", match.group(1).upper())
        if token in {"MUST_FIX", "FAIL"}:
            return "MUST_FIX"
        return "PASS"
    # Unparseable model output is a merge blocker; do not pass silently.
    return "MUST_FIX"


def parse_class(text: str) -> str:
    match = re.search(r"^CLASS:\s*([ABC])\s*$", text or "", re.I | re.M)
    return match.group(1).upper() if match else ""


def must_fix_remains(text: str) -> bool:
    return parse_verdict(text) == "MUST_FIX" or section_has_items(extract_section(text or "", "Must Fix"))


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 20] + "\n...[truncated]...\n"


def run_gh(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    token = env.get("GITHUB_TOKEN") or env.get("GH_TOKEN")
    if token and not env.get("GH_TOKEN"):
        env["GH_TOKEN"] = token
    completed = subprocess.run(
        ["gh", *args],
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if check and completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"gh {' '.join(args)} failed ({completed.returncode}): {err}")
    return completed


def repo_slug() -> str:
    return os.environ.get("GITHUB_REPOSITORY") or ""


def load_event() -> dict[str, Any]:
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        return {}
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def resolve_pr_number(cli_pr: str | None) -> str:
    if cli_pr:
        return str(cli_pr)
    for key in ("PR_NUMBER", "GH_PR_NUMBER"):
        if os.environ.get(key):
            return str(os.environ[key])
    event = load_event()
    number = (event.get("pull_request") or {}).get("number") or event.get("number")
    if number:
        return str(number)
    viewed = run_gh(["pr", "view", "--json", "number"])
    data = json.loads(viewed.stdout or "{}")
    if data.get("number"):
        return str(data["number"])
    raise RuntimeError("Could not resolve a pull request number")


def pr_metadata(pr: str) -> dict[str, Any]:
    raw = run_gh(
        [
            "pr",
            "view",
            pr,
            "--json",
            "number,title,body,url,isDraft,baseRefName,headRefName,author,files,additions,deletions",
        ]
    )
    return json.loads(raw.stdout)


def pr_diff(pr: str) -> str:
    raw = run_gh(["pr", "diff", pr, "--color=never"])
    return raw.stdout or ""


def changed_paths(meta: dict[str, Any]) -> list[str]:
    files = meta.get("files") or []
    paths: list[str] = []
    for item in files:
        path = normalize_repo_path(item.get("path") or "")
        if path:
            paths.append(path)
    return paths


def read_current_file(path: str) -> str | None:
    full = REPO_ROOT / path
    if not full.is_file():
        return None
    try:
        data = full.read_bytes()
    except OSError:
        return None
    if b"\x00" in data[:4096]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def budgeted_file_contents(paths: list[str]) -> tuple[str, list[str]]:
    chunks: list[str] = []
    skipped: list[str] = []
    used = 0
    for path in paths:
        if exclude_full_content(path):
            skipped.append(f"{path} (excluded lockfile/generated/fixture/binary)")
            continue
        text = read_current_file(path)
        if text is None:
            skipped.append(f"{path} (missing, deleted, or binary)")
            continue
        if len(text) > MAX_FILE_CHARS:
            skipped.append(f"{path} (over per-file budget {MAX_FILE_CHARS})")
            continue
        if used + len(text) > MAX_TOTAL_FILE_CHARS:
            skipped.append(f"{path} (over total full-content budget)")
            continue
        used += len(text)
        chunks.append(f"===== FILE {path} =====\n{text}\n===== END {path} =====")
    return "\n\n".join(chunks), skipped


def build_user_prompt(meta: dict[str, Any], diff: str, files_blob: str, skipped: list[str]) -> str:
    files = changed_paths(meta)
    author = (meta.get("author") or {}).get("login") or "unknown"
    human = needs_human_review(files, (meta.get("title") or "") + "\n" + (meta.get("body") or ""))
    skip_block = "\n".join(f"- {item}" for item in skipped) or "- none"
    return f"""Review this es-mini-agent pull request.

Title: {meta.get("title") or ""}
URL: {meta.get("url") or ""}
Author: {author}
Base: {meta.get("baseRefName")}  Head: {meta.get("headRefName")}
Additions/deletions: {meta.get("additions")}/{meta.get("deletions")}
Changed files:
{chr(10).join(f"- {p}" for p in files) or "- (none listed)"}

Human-merge surface (payments / Frame / client data / Eva / auth): {"YES" if human else "no"}

Body:
{clip(meta.get("body") or "(empty)", 8_000)}

## Diff (may be truncated)
{clip(diff or "(empty diff)", MAX_DIFF_CHARS)}

## Full current file contents (budgeted; excludes lockfiles/generated/fixtures)
{files_blob or "(no attachable file contents)"}

## Skipped full-content files
{skip_block}
"""


def anthropic_request_headers(api_key: str) -> dict[str, str]:
    """Headers for Messages API calls. Never logs key or workspace values."""
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
    }
    workspace_id = (os.environ.get("ANTHROPIC_WORKSPACE_ID") or "").strip()
    if workspace_id:
        headers["anthropic-workspace-id"] = workspace_id
    return headers


def anthropic_review(system: str, user: str, api_key: str) -> str:
    payload = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    request = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=anthropic_request_headers(api_key),
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Anthropic HTTP {exc.code}: {detail[:800]}") from exc
    parts = []
    for block in body.get("content") or []:
        if block.get("type") == "text" and block.get("text"):
            parts.append(block["text"])
    text = "\n".join(parts).strip()
    if not text:
        raise RuntimeError("Anthropic returned an empty review")
    return text


def existing_review_comment_id(pr: str) -> str | None:
    slug = repo_slug()
    if slug:
        raw = run_gh(["api", "--paginate", f"repos/{slug}/issues/{pr}/comments"])
    else:
        raw = run_gh(["api", "--paginate", f"repos/{{owner}}/{{repo}}/issues/{pr}/comments"])
    comments = json.loads(raw.stdout or "[]")
    if isinstance(comments, dict):
        comments = comments.get("data") or []
    for comment in comments:
        body = comment.get("body") or ""
        if COMMENT_MARKER in body:
            return str(comment["id"])
    return None


def post_or_update_comment(pr: str, body: str) -> None:
    """Update the previous AI review comment in place, or create one."""
    comment_id = existing_review_comment_id(pr)
    tmp = Path(os.environ.get("RUNNER_TEMP") or "/tmp") / "es-mini-agent-ai-pr-review.json"
    tmp.write_text(json.dumps({"body": body}), encoding="utf-8")
    slug = repo_slug()
    root = f"repos/{slug}" if slug else "repos/{owner}/{repo}"
    if comment_id:
        run_gh(["api", "-X", "PATCH", f"{root}/issues/comments/{comment_id}", "--input", str(tmp)])
        return
    run_gh(["api", f"{root}/issues/{pr}/comments", "--input", str(tmp)])


def render_comment(meta: dict[str, Any], review: str, skipped: list[str], human: bool) -> str:
    verdict = "MUST_FIX" if must_fix_remains(review) else "PASS"
    klass = parse_class(review) or ("C" if human else "B")
    if human:
        klass = "C"
    banner = ""
    if human:
        banner = (
            "> **Human review required.** This diff touches payments, Frame "
            "broker keys, client data, Eva, or auth/record secrets. Do not "
            "auto-merge. Anna / AB Wiki merge after reading this review.\n\n"
        )
    skip_note = ""
    if skipped:
        skip_note = (
            "\n<details><summary>Full-content skips</summary>\n\n"
            + "\n".join(f"- {item}" for item in skipped)
            + "\n\n</details>\n"
        )
    return (
        f"{COMMENT_MARKER}\n"
        f"## AI PR review (Staff Eng · {MODEL})\n\n"
        f"{banner}"
        f"**Verdict:** `{verdict}` · **Class:** `{klass}` "
        f"(class is informational; this check never auto-merges)\n\n"
        f"{review.strip()}\n"
        f"{skip_note}\n"
        f"— Reviewed `{meta.get('url')}` with the PR diff plus budgeted "
        f"current file contents to cut false Must Fix.\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="es-mini-agent AI PR review")
    parser.add_argument("--pr", help="Pull request number")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build the prompt and skip Anthropic + GitHub comment",
    )
    args = parser.parse_args(argv)

    pr = resolve_pr_number(args.pr)
    meta = pr_metadata(pr)
    if meta.get("isDraft"):
        print("Skipping draft pull request", file=sys.stderr)
        return 0

    paths = changed_paths(meta)
    diff = pr_diff(pr)
    files_blob, skipped = budgeted_file_contents(paths)
    human = needs_human_review(paths, (meta.get("title") or "") + "\n" + (diff[:20_000]))
    user_prompt = build_user_prompt(meta, diff, files_blob, skipped)

    if args.dry_run or os.environ.get("REVIEW_DRY_RUN") == "1":
        print(SYSTEM_PROMPT)
        print(user_prompt)
        print(f"human_review={human} skipped={len(skipped)}", file=sys.stderr)
        return 0

    api_key = os.environ.get("ANTHROPIC_API_KEY") or ""
    if not api_key:
        print(
            "ANTHROPIC_API_KEY is not set. Add the ES-owned repo/org secret "
            "and re-run. Do not put the value in the repository.",
            file=sys.stderr,
        )
        return 1

    review = anthropic_review(SYSTEM_PROMPT, user_prompt, api_key)
    comment = render_comment(meta, review, skipped, human)
    post_or_update_comment(pr, comment)
    print(comment)

    if must_fix_remains(review):
        print("Must Fix remains — failing the review job", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 — CI should fail closed
        print(f"review.py error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
