"""Deterministic query preprocessing.

No LLM is used here. The original query is preserved exactly; a separate
normalized form is produced for retrieval. Identifier extraction is
conservative: E-104 must never be confused with E-140 or E-014.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

from app.rag.types import ExtractedQuery, QueryKind

# ---------------------------------------------------------------------------
# Identifier patterns
# ---------------------------------------------------------------------------

# Letter-prefixed codes: E-104, E104, ERR_204, ALM-21, F102.
_LETTER_CODE = re.compile(
    r"\b(?P<code>(?:ERR|ALM|ALARM|ERROR|FAULT|EVT|EV|ER|E|F|A|H|P)[-_ ]?\d{2,5})\b",
    re.IGNORECASE,
)

# "error code E-104" / "fault: 204" catch-all. The captured token is re-checked.
_LABELED_CODE = re.compile(
    r"\b(?:error|alarm|fault|code)\s*(?:code\s*)?[:#]?\s*"
    r"(?P<code>[A-Z]{1,4}[-_ ]?\d{2,5})\b",
    re.IGNORECASE,
)

# Siemens-style 412.5 only when explicitly labelled as a code.
_DOTTED_CODE = re.compile(
    r"\b(?:error|alarm|fault|code)\s*(?:code\s*)?[:#]?\s*(?P<code>\d{3,4}\.\d{1,2})\b",
    re.IGNORECASE,
)

# Fastener / thread: M12 x 1.5
_FASTENER = re.compile(r"\b(M\d{1,3}\s*x\s*\d+(?:\.\d+)?)\b", re.IGNORECASE)

# Part-number-like tokens: TM-SVD-45A, PN-10422. Require a hyphen and a digit.
_PART_NUMBER = re.compile(r"\b([A-Z]{2,}(?:-[A-Z0-9]{2,}){1,4})\b")

# PLC addresses / I/O points: X1-14, I:3/4, %IX0.1
_IO_POINT = re.compile(r"\b((?:X|Y|I|Q|DI|DO|AI|AO)\d{1,2}[-/]\d{1,3})\b", re.IGNORECASE)

# Measurements with units. Unit is required so bare numbers are not harvested.
_UNIT = re.compile(
    r"\b(\d+(?:\.\d+)?\s*(?:VDC|VAC|VAC|V|mA|A|bar|psi|kPa|MPa|°C|℃|C|mm|rpm|Hz|kHz|kW|W|ms|s))\b",
    re.IGNORECASE,
)

# Model-like tokens mentioned explicitly ("model EC180SX" / "VF-2SS").
_LABELED_MODEL = re.compile(
    r"\b(?:model(?:\s+number)?|machine\s+model)\s*[:#]?\s*"
    r"(?P<model>[A-Z0-9][A-Z0-9._-]{1,24})\b",
    re.IGNORECASE,
)

_NAMED_MANUAL = re.compile(
    r"\b(?:in|from|per|see)\s+(?:the\s+)?(?P<title>[A-Z][^.]{4,80}manual)\b",
    re.IGNORECASE,
)
_NAMED_VERSION = re.compile(
    r"\b(?:version|rev(?:ision)?|ver)\s*[:#]?\s*(?P<ver>[\w.-]{1,16})\b",
    re.IGNORECASE,
)

_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "and",
        "or",
        "of",
        "to",
        "for",
        "in",
        "on",
        "at",
        "is",
        "are",
        "was",
        "be",
        "why",
        "how",
        "what",
        "when",
        "with",
        "from",
        "this",
        "that",
        "it",
        "during",
        "should",
        "would",
        "could",
        "do",
        "does",
        "i",
        "we",
        "my",
        "our",
        "please",
        "me",
        "about",
        "into",
        "over",
        "under",
        "after",
        "before",
        "while",
        "not",
        "no",
        "yes",
    }
)

_COMPONENT_LEXICON = frozenset(
    {
        "hydraulic",
        "hydraulics",
        "pump",
        "valve",
        "servo",
        "spindle",
        "plc",
        "filter",
        "motor",
        "pressure",
        "coolant",
        "encoder",
        "inverter",
        "contactor",
        "relay",
        "sensor",
        "cylinder",
        "manifold",
        "gearbox",
        "bearing",
        "fuse",
        "breaker",
        "solenoid",
        "actuator",
        "transducer",
        "thermocouple",
        "conveyor",
        "hopper",
        "nozzle",
        "heater",
        "fan",
        "belt",
        "coupling",
        "seal",
        "gasket",
        "hose",
        "fitting",
        "strainer",
        "accumulator",
        "reservoir",
        "tank",
        "compressor",
        "chiller",
        "transformer",
        "drive",
        "vfd",
        "startup",
        "start-up",
        "hydraulic pressure",
        "servo drive",
        "cooling filter",
        "tool changer",
        "limit switch",
        "proximity sensor",
        "pressure switch",
        "relief valve",
        "check valve",
        "flow control",
        "power supply",
        "i/o",
        "plc input",
        "plc output",
    }
)

_SYMPTOM_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"overheat(?:ing)?",
        r"leak(?:ing|age)?",
        r"vibrat(?:e|ion|ing)",
        r"noise",
        r"trip(?:ped|ping)?",
        r"shut\s*down",
        r"won't start",
        r"will not start",
        r"no pressure",
        r"low pressure",
        r"high (?:pressure|temperature)",
        r"drift",
        r"jam(?:med|ming)?",
        r"timeout",
        r"overload",
        r"underload",
        r"short circuit",
        r"open circuit",
        r"no voltage",
        r"won't reset",
        r"alarm",
        r"fault",
        r"error",
        r"not starting",
        r"stops? mid",
        r"intermittent",
    )
]

_ACTION_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"already (?:replaced|checked|cleaned|reset|inspected|tried)[\w\s-]{0,40}",
        r"(?:replaced|reset|cleaned|inspected) (?:the )?[\w-]{2,30}",
        r"tried [\w\s-]{2,40}",
    )
]

_CONDITION_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"during (?:hydraulic )?startup",
        r"after startup",
        r"at (?:idle|full load|operating temperature)",
        r"after \d+\s*(?:min(?:utes)?|hours?|s(?:ec(?:onds)?)?)",
        r"at \d+(?:\.\d+)?\s*°?C",
        r"on (?:cold|hot) start",
    )
]

_TROUBLESHOOTING_HINTS = re.compile(
    r"\b(?:why|cause|fix|repair|troubleshoot|diagnos|not working|won't|wont|"
    r"failed|failure|fault|alarm|error|symptom|check for|what should|"
    r"how do i (?:fix|repair|reset)|overheat|leak|trip|jam)\b",
    re.IGNORECASE,
)
_PROCEDURE_HINTS = re.compile(
    r"\b(?:how (?:do i|to)|procedure|steps?|replace|calibrat|install|"
    r"torque|adjust|bleed|prime)\b",
    re.IGNORECASE,
)

_WS = re.compile(r"\s+")


def query_hash(text: str) -> str:
    """SHA-256 of the original query. Safe to log; the text itself is not."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _uniq(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.strip()
        if not key:
            continue
        marker = key.casefold()
        if marker in seen:
            continue
        seen.add(marker)
        out.append(key)
    return out


def canonicalize_error_code(raw: str) -> str:
    """E-104 / e104 / E 104 → E-104. ERR_204 stays ERR_204 (underscore kept)."""
    token = raw.strip().upper()
    token = re.sub(r"\s+", "", token)
    if "_" in token:
        return token
    match = re.match(r"^([A-Z]+)[-]?(\d+)$", token)
    if match:
        return f"{match.group(1)}-{match.group(2)}"
    return token


def error_code_variants(code: str) -> list[str]:
    """Spelling variants that appear in manuals vs HMI text.

    E-104 → {E-104, E104, E 104, E_104}. Never produces E-140 or E-014.
    """
    canonical = canonicalize_error_code(code)
    compact = re.sub(r"[\s_-]+", "", canonical.upper())
    match = re.match(r"^([A-Z]+)(\d+)$", compact)
    if not match:
        return _uniq([canonical, compact, code.upper()])
    letters, digits = match.group(1), match.group(2)
    return _uniq(
        [
            f"{letters}-{digits}",
            f"{letters}{digits}",
            f"{letters} {digits}",
            f"{letters}_{digits}",
            canonical,
        ]
    )


def identifier_regex(code: str) -> re.Pattern[str]:
    """Word-boundary regex that will not match a different code.

    E-104 matches E-104 / E104 / E 104, but not E-1040, E-140, or E-014.
    """
    compact = re.sub(r"[\s_-]+", "", code.upper())
    match = re.match(r"^([A-Z]+)(\d+)$", compact)
    if match:
        letters, digits = match.group(1), match.group(2)
        pattern = rf"(?<![A-Z0-9]){re.escape(letters)}[\s_-]?{re.escape(digits)}(?!\d)"
        return re.compile(pattern, re.IGNORECASE)
    dotted = re.match(r"^(\d{3,4})\.(\d{1,2})$", compact.replace("-", "."))
    if dotted:
        pattern = rf"(?<!\d){re.escape(dotted.group(1))}\.{re.escape(dotted.group(2))}(?!\d)"
        return re.compile(pattern)
    return re.compile(rf"(?<![A-Z0-9]){re.escape(code)}(?![A-Z0-9])", re.IGNORECASE)


def _extract_error_codes(text: str) -> list[str]:
    found: list[str] = []
    for match in _LETTER_CODE.finditer(text):
        found.append(canonicalize_error_code(match.group("code")))
    for match in _LABELED_CODE.finditer(text):
        found.append(canonicalize_error_code(match.group("code")))
    for match in _DOTTED_CODE.finditer(text):
        found.append(match.group("code"))
    return _uniq(found)


def _extract_terms(text: str) -> list[str]:
    lowered = text.casefold()
    found: list[str] = []
    # Multi-word lexicon entries first so "hydraulic pressure" wins over "hydraulic".
    multi = sorted((t for t in _COMPONENT_LEXICON if " " in t), key=len, reverse=True)
    consumed = lowered
    for phrase in multi:
        if phrase in consumed:
            found.append(phrase)
            consumed = consumed.replace(phrase, " ")
    for token in re.findall(r"[a-z0-9][a-z0-9\-/]{2,}", consumed):
        if token in _COMPONENT_LEXICON and token not in _STOPWORDS:
            found.append(token)
    return _uniq(found)


def _classify(text: str, error_codes: list[str], named_manual: str | None) -> QueryKind:
    if named_manual:
        return "manual_reference"
    if error_codes:
        return "error_code"
    if _TROUBLESHOOTING_HINTS.search(text):
        return "troubleshooting"
    if _PROCEDURE_HINTS.search(text):
        return "procedure"
    return "general"


def _requires_scope(kind: QueryKind, error_codes: list[str]) -> bool:
    if error_codes:
        return True
    return kind in {"error_code", "troubleshooting", "procedure", "manual_reference"}


def normalize_query(original: str) -> ExtractedQuery:
    """Extract identifiers and produce a retrieval-normalized query.

    The original string is stored unchanged. Normalization is NFKC + whitespace
    collapse; error codes inside the normalized form are canonicalised.
    """
    if original is None:
        original = ""
    nfkc = unicodedata.normalize("NFKC", original)
    collapsed = _WS.sub(" ", nfkc).strip()

    error_codes = _extract_error_codes(collapsed)
    variants: list[str] = []
    for code in error_codes:
        variants.extend(error_code_variants(code))
    variants = _uniq(variants)

    fasteners = [m.group(1) for m in _FASTENER.finditer(collapsed)]
    parts = [m.group(1).upper() for m in _PART_NUMBER.finditer(collapsed)]
    io_points = [m.group(1).upper() for m in _IO_POINT.finditer(collapsed)]
    units = [re.sub(r"\s+", " ", m.group(1)).upper() for m in _UNIT.finditer(collapsed)]
    models = [m.group("model").upper() for m in _LABELED_MODEL.finditer(collapsed)]

    named_manual = None
    manual_match = _NAMED_MANUAL.search(collapsed)
    if manual_match:
        named_manual = manual_match.group("title").strip()
    named_version = None
    version_match = _NAMED_VERSION.search(collapsed)
    if version_match:
        named_version = version_match.group("ver").strip()

    terms = _extract_terms(collapsed)
    symptoms = _uniq(
        [m.group(0).lower() for pat in _SYMPTOM_PATTERNS for m in pat.finditer(collapsed)]
    )
    actions = _uniq(
        [m.group(0).strip() for pat in _ACTION_PATTERNS for m in pat.finditer(collapsed)]
    )
    conditions = _uniq(
        [m.group(0).strip() for pat in _CONDITION_PATTERNS for m in pat.finditer(collapsed)]
    )

    kind = _classify(collapsed, error_codes, named_manual)

    # Normalized query: collapsed whitespace, error codes canonicalised in-place.
    normalized = collapsed
    for code in error_codes:
        normalized = identifier_regex(code).sub(code, normalized)
    normalized = _WS.sub(" ", normalized).strip()

    components = _uniq([*terms, *io_points])

    return ExtractedQuery(
        original=original,
        normalized=normalized,
        error_codes=error_codes,
        error_code_variants=variants,
        part_numbers=_uniq([*parts, *fasteners]),
        model_numbers=_uniq(models),
        units=_uniq(units),
        technical_terms=terms,
        component_names=components,
        symptoms=symptoms,
        actions_attempted=actions,
        operating_conditions=conditions,
        kind=kind,
        requires_machine_scope=_requires_scope(kind, error_codes),
        named_manual=named_manual,
        named_version=named_version,
    )


def extracted_to_public(extracted: ExtractedQuery) -> dict[str, object]:
    return {
        "original": extracted.original,
        "normalized": extracted.normalized,
        "detectedErrorCodes": extracted.error_codes,
        "detectedTerms": extracted.technical_terms,
        "detectedModelNumbers": extracted.model_numbers,
        "detectedPartNumbers": extracted.part_numbers,
        "detectedUnits": extracted.units,
        "detectedSymptoms": extracted.symptoms,
        "kind": extracted.kind,
        "requiresMachineScope": extracted.requires_machine_scope,
    }
