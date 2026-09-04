"""Maintenance history lane (Phase 7 / roadmap Phase 8, AC-13).

The third evidence class, and the one that is NEVER evidence of causation:

- maintenance appears ONLY as `maintenance_context`, never inside
  `manual_evidence`;
- every entry carries `days_before_incident` and a deterministic
  `correlation_strength`;
- `causal_claim` is always False - no matter what the data looks like;
- part-number intersection with the retrieved MANUAL evidence produces a
  deterministic `noted_by_manual` correlation with a manual citation.

Everything here is deterministic. Nothing is learned, inferred from the
model, or guessed - exactly like the ranking and similarity modules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.rag.types import SourceRef

# Correlation windows and thresholds (kept small and explicit for tests).
RECENT_DAYS = 30
CORRELATION_STRONG = "strong"
CORRELATION_MODERATE = "moderate"
CORRELATION_WEAK = "weak"

_PART_CLEAN = re.compile(r"[^a-zA-Z0-9]")


def normalise_part_token(part_number: str) -> str:
    """Same normalisation family as the backend's normalisePartNumber."""
    return _PART_CLEAN.sub("", (part_number or "").strip()).upper()


@dataclass(frozen=True)
class MaintenanceContextItem:
    """One maintenance record as passed by Express (already org/machine
    scoped and bounded)."""

    id: str
    maintenance_type: str
    title: str
    performed_at: str
    parts_replaced: list[dict[str, Any]]
    related_incident_id: str | None = None


@dataclass(frozen=True)
class MaintenanceEvidence:
    """A maintenance record after deterministic analysis."""

    item: MaintenanceContextItem
    days_before_incident: int
    correlation_strength: str
    causal_claim: bool = False
    noted_by_manual: bool = False
    noted_by_manual_source_id: str | None = None


def parse_maintenance_context(raw: Any) -> list[MaintenanceContextItem]:
    """Tolerantly parse the Express payload; malformed rows are skipped with
    the caller recording a warning rather than failing the answer."""
    if not isinstance(raw, list):
        return []
    items: list[MaintenanceContextItem] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        if not row.get("id") or not row.get("title") or not row.get("performed_at"):
            continue
        parts = row.get("parts_replaced") or []
        items.append(
            MaintenanceContextItem(
                id=str(row["id"]),
                maintenance_type=str(row.get("maintenance_type") or "unknown"),
                title=str(row["title"]),
                performed_at=str(row["performed_at"]),
                parts_replaced=[
                    p for p in parts if isinstance(p, dict) and p.get("part_number")
                ],
                related_incident_id=(
                    str(row["related_incident_id"]) if row.get("related_incident_id") else None
                ),
            )
        )
    return items


def compute_days_before(performed_at: str, query_at: str | None) -> int:
    """Whole days between the maintenance event and the query."""
    try:
        performed = datetime.fromisoformat(performed_at.replace("Z", "+00:00"))
        reference = (
            datetime.fromisoformat(query_at.replace("Z", "+00:00"))
            if query_at
            else datetime.now(timezone.utc)
        )
        if performed.tzinfo is None:
            performed = performed.replace(tzinfo=timezone.utc)
        if reference.tzinfo is None:
            reference = reference.replace(tzinfo=timezone.utc)
        days = (reference - performed).days
        return max(days, 0)
    except (ValueError, TypeError):
        return 0


def part_tokens(item: MaintenanceContextItem) -> set[str]:
    tokens: set[str] = set()
    for part in item.parts_replaced:
        token = normalise_part_token(str(part.get("part_number") or ""))
        if token:
            tokens.add(token)
    return tokens


def _query_mentions_part(query_text: str, tokens: set[str]) -> bool:
    if not tokens:
        return False
    query_tokens = [
        _PART_CLEAN.sub("", token).upper()
        for token in re.split(r"\s+", (query_text or ""))
        if _PART_CLEAN.sub("", token)
    ]
    compact = "".join(query_tokens)
    for token in tokens:
        if len(token) < 3:
            continue
        if token in compact:
            return True
        # Word-prefix match: part "STRAINER88" is mentioned by "strainer".
        prefix_match = re.match(r"[A-Z]+", token)
        if prefix_match and len(prefix_match.group(0)) >= 4:
            if prefix_match.group(0) in query_tokens:
                return True
        # The query may carry a longer code of which the part is a prefix.
        if any(q.startswith(token) and len(q) > len(token) for q in query_tokens):
            return True
    return False


def compute_correlation_strength(
    item: MaintenanceContextItem,
    query_text: str,
    days_before: int,
) -> str:
    """Deterministic strength:
    - strong: the user's question names a part that was replaced/serviced;
    - moderate: recent machine-scoped maintenance (<= RECENT_DAYS);
    - weak: everything else.
    """
    tokens = part_tokens(item)
    if tokens and _query_mentions_part(query_text, tokens):
        return CORRELATION_STRONG
    if days_before <= RECENT_DAYS:
        return CORRELATION_MODERATE
    return CORRELATION_WEAK


def correlate_noted_by_manual(
    item: MaintenanceContextItem,
    manual_hits: list[Any],
) -> tuple[bool, str | None]:
    """Deterministic `noted_by_manual`: True iff a replaced part number also
    appears in the retrieved MANUAL evidence text. Returns the source id of
    the first matching manual hit so the prompt can cite it."""
    tokens = part_tokens(item)
    if not tokens:
        return False, None
    for hit in manual_hits:
        raw_text = getattr(hit, "text", None) or ""
        compact_text = _PART_CLEAN.sub("", raw_text).upper()
        for token in tokens:
            if token in compact_text:
                return True, getattr(hit, "source_id", None)
    return False, None


def build_maintenance_evidence(
    raw_items: Any,
    query_at: str | None,
    query_text: str,
    manual_hits: list[Any],
) -> list[MaintenanceEvidence]:
    """The full deterministic pipeline: parse -> days -> strength -> noted_by_manual.

    Accepts either the raw Express payload or an already-parsed list.
    """
    items = (
        raw_items
        if isinstance(raw_items, list)
        and all(isinstance(i, MaintenanceContextItem) for i in raw_items)
        else parse_maintenance_context(raw_items)
    )
    evidence: list[MaintenanceEvidence] = []
    for item in items:
        days = compute_days_before(item.performed_at, query_at)
        strength = compute_correlation_strength(item, query_text, days)
        noted, source_id = correlate_noted_by_manual(item, manual_hits)
        evidence.append(
            MaintenanceEvidence(
                item=item,
                days_before_incident=days,
                correlation_strength=strength,
                causal_claim=False,
                noted_by_manual=noted,
                noted_by_manual_source_id=source_id,
            )
        )
    return evidence


def format_maintenance_context_block(
    evidence: list[MaintenanceEvidence],
    max_chars: int = 1_200,
) -> str:
    """Render the maintenance lane for the prompt. Explicitly non-causal."""
    lines: list[str] = []
    for entry in evidence:
        item = entry.item
        parts = ", ".join(
            str(p.get("part_number")) for p in item.parts_replaced if p.get("part_number")
        )
        lines.append(
            f"- [{item.maintenance_type}] {item.title} "
            f"({entry.days_before_incident} days before the question"
            + (f", part(s): {parts}" if parts else "")
            + f"; correlation_strength={entry.correlation_strength}; "
            + "causal_claim=false)"
        )
        if entry.noted_by_manual:
            lines.append(
                "  noted_by_manual: the manual evidence also mentions a serviced part"
                + (f" (see {entry.noted_by_manual_source_id})" if entry.noted_by_manual_source_id else "")
                + " - correlation only, NOT causation."
            )
    block = "\n".join(lines)
    if len(block) > max_chars:
        cut = block.rfind("\n", 0, max_chars)
        block = block[: cut if cut > 0 else max_chars] + "\n(truncated)"
    return block


def build_maintenance_source_refs(
    evidence: list[MaintenanceEvidence],
) -> list[SourceRef]:
    """`maint-N` source refs, one per entry. Never page numbers."""
    refs: list[SourceRef] = []
    for index, entry in enumerate(evidence, start=1):
        item = entry.item
        refs.append(
            SourceRef(
                source_id=f"maint-{index}",
                chunk_id=item.id,
                manual_id="",
                manual_title=f"MAINTENANCE {item.maintenance_type.upper()}",
                manual_version=None,
                page_start=0,
                page_end=0,
                section_title=item.title,
                machine_model_id=None,
                excerpt=None,
                source_type="maintenance",
                maintenance_id=item.id,
                days_before_incident=entry.days_before_incident,
                correlation_strength=entry.correlation_strength,
                causal_claim=entry.causal_claim,
                noted_by_manual=entry.noted_by_manual,
                noted_by_manual_source_id=entry.noted_by_manual_source_id,
            )
        )
    return refs
