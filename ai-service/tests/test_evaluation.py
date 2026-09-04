"""Evaluation corpus: expected retrieval/RAG behaviours on the synthetic manuals."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.rag.generate import ScriptedGenerator
from app.rag.pipeline import PipelineDeps, PipelineRequest, run_answer, run_search
from app.rag.semantic import MemoryVectorIndex
from app.rag.store import MemoryChunkStore
from tests.helpers_rag import (
    MODEL_A,
    MODEL_B,
    FakeEmbedder,
    chunk_vector,
    chunks,
    manuals,
    rag_runtime_config,
)

CORPUS = Path(__file__).parent / "fixtures" / "evaluation" / "corpus.json"

GOOD_JSON = json.dumps(
    {
        "summary": "Grounded answer from retrieved evidence.",
        "likely_causes": ["clogged suction filter"],
        "recommended_checks": ["Check the suction strainer"],
        "safety_notes": ["Apply LOTO."],
        "when_to_escalate": "",
        "cited_source_ids": ["source-1"],
        "evidence_insufficient": False,
        "notes_on_conflicts": "",
    }
)


def _model(token: str | None) -> str | None:
    if token == "MODEL_A":
        return MODEL_A
    if token == "MODEL_B":
        return MODEL_B
    return None


def _deps(generator: ScriptedGenerator | None = None) -> PipelineDeps:
    corpus = chunks()
    return PipelineDeps(
        store=MemoryChunkStore(manuals=manuals(), chunks=corpus),
        embedder=FakeEmbedder(),
        vectors=MemoryVectorIndex([(c, chunk_vector(c)) for c in corpus], dimension=4),
        generator=generator or ScriptedGenerator([GOOD_JSON, GOOD_JSON]),
        config=rag_runtime_config(),
        embedding_model="nomic-embed-text",
    )


def _cases() -> list[dict]:
    payload = json.loads(CORPUS.read_text(encoding="utf-8"))
    return list(payload["cases"])


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["id"])
async def test_evaluation_case(case: dict) -> None:
    gen = ScriptedGenerator([GOOD_JSON, GOOD_JSON])
    deps = _deps(gen)
    model_id = _model(case.get("machine_model_id"))
    req = PipelineRequest(query=case["query"], machine_model_id=model_id, debug=True)

    search = await run_search(req, deps)
    answer = await run_answer(req, deps)

    expected = case["expect_status"]
    allowed = expected if isinstance(expected, list) else [expected]
    assert answer.status in allowed, f"{case['id']}: {answer.status} not in {allowed}"

    if case.get("expect_reason"):
        assert answer.reason == case["expect_reason"]

    if case.get("expect_error_code"):
        assert case["expect_error_code"] in (answer.query.get("detectedErrorCodes") or [])

    if case.get("expect_exact_matches") is not None:
        assert search["retrieval"]["exact_matches"] == case["expect_exact_matches"]

    if case.get("expect_manual_title"):
        blob = json.dumps(answer.sources or search["results"])
        assert case["expect_manual_title"] in blob

    if case.get("expect_pages"):
        pages = {
            p
            for item in (answer.sources or search["results"])
            for p in range(int(item.get("page_start") or 0), int(item.get("page_end") or 0) + 1)
        }
        for page in case["expect_pages"]:
            assert page in pages, f"{case['id']}: expected page {page} in {pages}"

    if case.get("must_not_cite_manual"):
        blob = json.dumps({"sources": answer.sources, "results": search["results"]})
        assert case["must_not_cite_manual"] not in blob

    if case.get("must_wrap_user_input"):
        assert gen.calls
        user = gen.calls[0][1]["content"]
        assert "<<<UNTRUSTED_USER_INPUT>>>" in user
