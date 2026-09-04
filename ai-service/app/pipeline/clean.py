"""Deterministic text cleaning + lightweight heading detection.

Cleaning rules (everything here is deterministic; no LLM, no rewriting):
  - normalise line endings, collapse repeated blank lines
  - collapse runs of spaces but keep single spaces
  - preserve error codes (E-104), numbers+units (24 VDC, 3.5 bar, M12 x 1.5)
  - preserve bullet markers and meaningful line breaks
  - do NOT summarise, paraphrase, or aggressively correct spelling

Heading detection is deliberately best-effort (docs/CHUNKING_STRATEGY.md): the
signals are short lines, all-caps lines, numbered sections, lines that look like
section titles, and common manual keywords. When nothing reliable is found the
heading is recorded as None rather than guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Common industrial-manual section keywords (case-insensitive).
_SECTION_KEYWORDS = {
    "warning",
    "caution",
    "danger",
    "note",
    "troubleshooting",
    "installation",
    "maintenance",
    "operation",
    "specifications",
    "electrical",
    "hydraulic",
    "safety",
    "introduction",
    "overview",
    "parts",
    "calibration",
    "adjustment",
}

# Numbered / stepped heading, e.g. "3.2", "3.2.1", "7.5".
_NUMBERED = re.compile(r"^\s*\d+(\.\d+)+\s+[A-Za-z]")


def clean_text(raw: str) -> str:
    """Normalise extracted text.

    - line endings -> \n
    - zero-width / control chars stripped
    - spaces collapsed to a single space
    - blank-line runs collapsed to at most one blank line
    - trailing whitespace removed per line
    """
    if not raw:
        return ""

    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    # Strip non-printable control characters (keep \n, \t).
    text = "".join(ch if ch == "\n" or ch == "\t" or ch > "\x1f" else " " for ch in text)
    # Tabs to a single space.
    text = text.replace("\t", " ")
    # Collapse runs of spaces (but never the newline structure).
    text = re.sub(r"[ \t]{2,}", " ", text)
    # Collapse 3+ blank lines to one blank line.
    text = re.sub(r"\n[ \t]*\n[ \t]*\n+", "\n\n", text)
    # Trim leading AND trailing whitespace per line (a leading-space fragment is
    # an artifact of table/column layouts, not meaningful for chunk text), then
    # trim the ends.
    lines = [line.strip() for line in text.split("\n")]
    cleaned = "\n".join(lines).strip()
    return cleaned


@dataclass
class Heading:
    title: str
    level: int
    line_index: int
    # Ancestor titles used to build a `section_path` (#/##/###).
    parents: list[str] = field(default_factory=list)

    @property
    def path(self) -> list[str]:
        return [*self.parents, self.title]


def _looks_like_heading(line: str, next_line: str | None) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    # Too long to be a heading (but keep room for long titles).
    if len(stripped) > 120:
        return False
    # All-caps (>=4 chars) with no sentence punctuation at end.
    if len(stripped) >= 4 and stripped.isupper() and not stripped.endswith((".", ",", ";", ":")):
        return True
    # Numbered section: "3.2 Hydraulic Pressure Check".
    if _NUMBERED.match(stripped):
        return True
    # Keyword-led section.
    first_word = re.split(r"[\s:.]+", stripped)[0].lower()
    if first_word in _SECTION_KEYWORDS and len(stripped) <= 80:
        return True
    # A short line followed by a longer paragraph line is a likely title.
    if next_line and len(stripped) <= 70:
        next_stripped = next_line.strip()
        if (
            len(next_stripped) > max(len(stripped), 1)
            and not next_stripped.isupper()
            and not next_stripped.startswith(("•", "-", "*"))
        ):
            return True
    return False


def _heading_level(stripped: str) -> int:
    if _NUMBERED.match(stripped):
        # Count dot-separated groups -> depth.
        return stripped.split()[0].count(".") + 1
    if _SECTION_KEYWORDS.intersection(stripped.lower().split()):
        return 1
    return 1


def detect_headings(text: str) -> list[Heading]:
    """Return best-effort headings in document order.

    `line_index` is the index into `text.split('\n')` so the chunker can attach
    the nearest preceding heading to a chunk.
    """
    lines = text.split("\n")
    headings: list[Heading] = []
    # Stack of (level, title) used to compute section paths.
    stack: list[tuple[int, str]] = []

    for idx, line in enumerate(lines):
        next_line = lines[idx + 1] if idx + 1 < len(lines) else None
        if not _looks_like_heading(line, next_line):
            continue
        title = line.strip()
        level = _heading_level(title)

        # Pop stack entries deeper than the current level.
        while stack and stack[-1][0] >= level:
            stack.pop()
        parents = [t for _, t in stack]
        stack.append((level, title))

        headings.append(Heading(title=title, level=level, line_index=idx, parents=parents))

    return headings


def nearest_heading_before(headings: list[Heading], line_index: int) -> Heading | None:
    """Find the closest heading whose line index is <= `line_index`."""
    chosen: Heading | None = None
    for h in headings:
        if h.line_index <= line_index:
            chosen = h
        elif h.line_index > line_index:
            break
    return chosen
