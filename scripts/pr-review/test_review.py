#!/usr/bin/env python3
"""Unit tests for es-mini-agent AI PR review helpers (no network, no secrets)."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from review import (
    ANTHROPIC_VERSION,
    COMMENT_MARKER,
    anthropic_request_headers,
    exclude_full_content,
    extract_section,
    must_fix_remains,
    needs_human_review,
    normalize_repo_path,
    parse_class,
    parse_verdict,
    render_comment,
    section_has_items,
)


class ExcludeFullContentTests(unittest.TestCase):
    def test_lockfiles_and_generated(self) -> None:
        self.assertTrue(exclude_full_content("package-lock.json"))
        self.assertTrue(exclude_full_content("ios/Podfile.lock"))
        self.assertTrue(exclude_full_content("www/index.html"))
        self.assertTrue(exclude_full_content("test/fixtures/member.json"))
        self.assertTrue(exclude_full_content("img/logo.png"))
        self.assertTrue(exclude_full_content("worker/.wrangler/state.json"))
        self.assertTrue(exclude_full_content("coverage/lcov.info"))

    def test_source_stays_attached(self) -> None:
        self.assertFalse(exclude_full_content("api/stripe.js"))
        self.assertFalse(exclude_full_content("worker/src/worker.mjs"))
        self.assertFalse(exclude_full_content("index.html"))
        self.assertFalse(exclude_full_content("HANDOVER.md"))
        self.assertFalse(exclude_full_content(".github/workflows/ai-pr-review.yml"))

    def test_dot_github_path_keeps_leading_dot(self) -> None:
        self.assertEqual(
            normalize_repo_path("./.github/workflows/ai-pr-review.yml"),
            ".github/workflows/ai-pr-review.yml",
        )


class HumanReviewTests(unittest.TestCase):
    def test_installer_selfupdate_power_secrets_are_human(self) -> None:
        self.assertTrue(needs_human_review(["install.sh"]))
        self.assertTrue(needs_human_review(["self-update.js"]))
        self.assertTrue(needs_human_review(["modules.txt"]))
        self.assertTrue(needs_human_review(["power.js"]))
        self.assertTrue(needs_human_review(["com.es.obs-launcher.plist"]))
        self.assertTrue(needs_human_review([".github/workflows/ai-pr-review.yml"]))
        self.assertTrue(needs_human_review(["docs/note.md"], "rotate RECORD_CONTROL_KEY"))

    def test_docs_only_is_not_human(self) -> None:
        self.assertFalse(needs_human_review(["HANDOVER.md", "README.md"]))


class VerdictTests(unittest.TestCase):
    def test_pass_none(self) -> None:
        text = "VERDICT: PASS\nCLASS: A\nSUMMARY: docs\n\n## Must Fix\nNone\n\n## Should Fix\nNone\n"
        self.assertEqual(parse_verdict(text), "PASS")
        self.assertEqual(parse_class(text), "A")
        self.assertFalse(must_fix_remains(text))
        self.assertFalse(section_has_items(extract_section(text, "Must Fix")))

    def test_must_fix_line_fails_even_if_verdict_pass(self) -> None:
        text = (
            "VERDICT: PASS\nCLASS: C\nSUMMARY: oops\n\n"
            "## Must Fix\n- api/stripe.js skips payment-method ownership\n"
        )
        self.assertTrue(must_fix_remains(text))

    def test_explicit_must_fix(self) -> None:
        text = "VERDICT: MUST_FIX\n\n## Must Fix\n- leaked RECORD_CONTROL_KEY\n"
        self.assertEqual(parse_verdict(text), "MUST_FIX")
        self.assertTrue(must_fix_remains(text))

    def test_empty_must_fix_is_pass(self) -> None:
        text = "VERDICT: PASS\n\n## Must Fix\n- None\n"
        self.assertFalse(must_fix_remains(text))

    def test_unparseable_review_fails_closed(self) -> None:
        self.assertEqual(parse_verdict("thanks, lgtm"), "MUST_FIX")
        self.assertTrue(must_fix_remains("thanks, lgtm"))


class AnthropicHeaderTests(unittest.TestCase):
    def test_workspace_id_header_when_env_set(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_WORKSPACE_ID": "wrkspc_test"}, clear=False):
            headers = anthropic_request_headers("sk-ant-test")
        self.assertEqual(headers["anthropic-workspace-id"], "wrkspc_test")
        self.assertEqual(headers["x-api-key"], "sk-ant-test")
        self.assertEqual(headers["anthropic-version"], ANTHROPIC_VERSION)
        self.assertEqual(headers["content-type"], "application/json")

    def test_omits_workspace_id_when_env_empty(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_WORKSPACE_ID": ""}, clear=False):
            headers = anthropic_request_headers("sk-ant-test")
        self.assertNotIn("anthropic-workspace-id", headers)
        self.assertEqual(headers["x-api-key"], "sk-ant-test")
        self.assertEqual(headers["anthropic-version"], ANTHROPIC_VERSION)


class CommentTests(unittest.TestCase):
    def test_human_banner_and_marker(self) -> None:
        meta = {"url": "https://github.com/annabuies/es-mini-agent/pull/1"}
        body = render_comment(meta, "VERDICT: PASS\nCLASS: A\n\n## Must Fix\nNone\n", [], True)
        self.assertIn(COMMENT_MARKER, body)
        self.assertIn("Human review required", body)
        self.assertIn("**Class:** `C`", body)
        self.assertNotIn("sk-ant-", body)


if __name__ == "__main__":
    unittest.main()
