#!/usr/bin/env python3
"""Unit tests for the pure helpers in scripts/notes.py.

Run: python3 scripts/test_notes.py
No network, LLM, or document dependencies required.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import notes  # noqa: E402


class CourseCodeTests(unittest.TestCase):
    def test_term_prefixed_name(self):
        self.assertEqual(notes.derive_course_code("2609-CS482EX1-5A7EE7"), "CS482")
        self.assertEqual(notes.derive_course_code("2609-EIE470EX1-173EA3"), "EIE470")

    def test_plain_title(self):
        self.assertEqual(notes.derive_course_code("CS482 數據科學"), "CS482")

    def test_no_code(self):
        self.assertEqual(notes.derive_course_code("數據科學"), "")
        self.assertEqual(notes.derive_course_code(""), "")


class EnvLineTests(unittest.TestCase):
    def test_export_prefix(self):
        self.assertEqual(notes._parse_env_line("export FOO=bar"), ("FOO", "bar"))

    def test_quoted_value(self):
        self.assertEqual(notes._parse_env_line('FOO="a b"'), ("FOO", "a b"))

    def test_inline_comment(self):
        self.assertEqual(notes._parse_env_line("FOO=bar # comment"), ("FOO", "bar"))

    def test_comment_or_invalid(self):
        self.assertIsNone(notes._parse_env_line("# comment"))
        self.assertIsNone(notes._parse_env_line("not an assignment"))
        self.assertIsNone(notes._parse_env_line("1BAD=x"))


class PathSafetyTests(unittest.TestCase):
    def test_safe_name_strips_separators(self):
        self.assertEqual(notes.safe_name("a/b:c"), "a_b_c")

    def test_safe_name_never_empty(self):
        self.assertEqual(notes.safe_name(".."), "course")
        self.assertEqual(notes.safe_name(""), "course")

    def test_note_path_has_no_traversal(self):
        meta = {
            "course": "CS482 數據科學",
            "courseCode": "CS482",
            "filename": "../../evil.pdf",
            "date": "../../2026-01-01",
            "fileUrl": "https://moodle.must.edu.mo/pluginfile.php/1/x.pdf",
        }
        path = notes.note_path_for(Path("/tmp/vault"), meta)
        self.assertNotIn("..", path.parts)
        self.assertEqual(path.name, "2026-01-01 evil.md")

    def test_is_within(self):
        base = Path("/tmp/vault/Courses")
        self.assertTrue(notes.is_within(base, base / "CS482" / "note.md"))
        self.assertFalse(notes.is_within(base, base / ".." / "escape.md"))


class YamlTests(unittest.TestCase):
    def test_quotes_are_escaped(self):
        self.assertEqual(notes.yaml_string('a"b'), '"a\\"b"')

    def test_frontmatter_is_parseable_looking(self):
        meta = {
            "course": 'CS482 "Data"',
            "courseCode": "CS482",
            "filename": 'lecture "1".pdf',
            "date": "2026-01-01",
            "fileUrl": "https://example.test/a.pdf",
        }
        text = notes.note_frontmatter(meta)
        self.assertTrue(text.startswith("---\n"))
        self.assertIn('course: "CS482 \\"Data\\""', text)
        self.assertIn("tags: [courseware, \"CS482\"]", text)


if __name__ == "__main__":
    unittest.main()
