"""Shared synthetic corpus for retrieval / RAG unit tests."""

from __future__ import annotations

from app.rag.types import ChunkRecord, ManualRecord, RagRuntimeConfig, RankingWeights

MODEL_A = "aaaaaaaaaaaaaaaaaaaaaaaa"
MODEL_B = "bbbbbbbbbbbbbbbbbbbbbbbb"
MANUAL_A = "cccccccccccccccccccccccc"
MANUAL_A_V2 = "dddddddddddddddddddddddd"
MANUAL_B = "eeeeeeeeeeeeeeeeeeeeeeee"


def manuals() -> list[ManualRecord]:
    return [
        ManualRecord(
            manual_id=MANUAL_A,
            title="Hydraulic Service Manual",
            version="2.1",
            manual_type="service",
            manufacturer="Haas",
            language="en",
            machine_model_id=MODEL_A,
            machine_id=None,
            is_current_version=True,
        ),
        ManualRecord(
            manual_id=MANUAL_A_V2,
            title="Hydraulic Service Manual",
            version="1.0",
            manual_type="service",
            manufacturer="Haas",
            language="en",
            machine_model_id=MODEL_A,
            machine_id=None,
            is_current_version=False,
        ),
        ManualRecord(
            manual_id=MANUAL_B,
            title="Press Service Manual",
            version="3.0",
            manual_type="service",
            manufacturer="Schuler",
            language="en",
            machine_model_id=MODEL_B,
            machine_id=None,
            is_current_version=True,
        ),
    ]


def chunks() -> list[ChunkRecord]:
    return [
        ChunkRecord(
            chunk_id=f"{MANUAL_A}:0",
            mongo_id=None,
            manual_id=MANUAL_A,
            machine_model_id=MODEL_A,
            machine_id=None,
            chunk_index=0,
            page_start=42,
            page_end=43,
            section_title="Hydraulic Pressure Troubleshooting",
            section_path=["Hydraulics", "Troubleshooting"],
            text=(
                "Error E-104 Hydraulic pressure low during startup. "
                "Likely causes: clogged suction filter, worn pump, relief valve set below 200 bar. "
                "Check the suction strainer, then measure pressure at port P1. "
                "Isolate energy and apply LOTO before opening the reservoir."
            ),
            content_hash="hash-e104-v21",
            manual_title="Hydraulic Service Manual",
            manual_version="2.1",
            manual_type="service",
        ),
        ChunkRecord(
            chunk_id=f"{MANUAL_A}:1",
            mongo_id=None,
            manual_id=MANUAL_A,
            machine_model_id=MODEL_A,
            machine_id=None,
            chunk_index=1,
            page_start=44,
            page_end=44,
            section_title="Hydraulic Pressure Troubleshooting",
            section_path=["Hydraulics", "Troubleshooting"],
            text="If pressure remains below 180 bar after cleaning the filter, replace the pump cartridge.",
            content_hash="hash-followon",
            manual_title="Hydraulic Service Manual",
            manual_version="2.1",
        ),
        ChunkRecord(
            chunk_id=f"{MANUAL_A_V2}:0",
            mongo_id=None,
            manual_id=MANUAL_A_V2,
            machine_model_id=MODEL_A,
            machine_id=None,
            chunk_index=0,
            page_start=18,
            page_end=18,
            section_title="Fault E-104",
            section_path=["Faults"],
            text=(
                "Error E-104 Hydraulic pressure low. Relief valve should be set to 250 bar. "
                "Inspect component B first."
            ),
            content_hash="hash-e104-v10",
            manual_title="Hydraulic Service Manual",
            manual_version="1.0",
            is_current_version=False,
        ),
        ChunkRecord(
            chunk_id=f"{MANUAL_B}:0",
            mongo_id=None,
            manual_id=MANUAL_B,
            machine_model_id=MODEL_B,
            machine_id=None,
            chunk_index=0,
            page_start=10,
            page_end=10,
            section_title="Electrical faults",
            section_path=["Electrical"],
            text="Error E-104 on this press means a servo overload on the ram axis. Reset is not permitted.",
            content_hash="hash-e104-press",
            manual_title="Press Service Manual",
            manual_version="3.0",
        ),
        ChunkRecord(
            chunk_id=f"{MANUAL_A}:9",
            mongo_id=None,
            manual_id=MANUAL_A,
            machine_model_id=MODEL_A,
            machine_id=None,
            chunk_index=9,
            page_start=90,
            page_end=90,
            section_title="Specifications",
            section_path=["Specs"],
            text="Supply voltage 24 VDC. Fastener M12 x 1.5 on the manifold. PLC input X1-14 monitors filter DP.",
            content_hash="hash-specs",
            manual_title="Hydraulic Service Manual",
            manual_version="2.1",
        ),
        ChunkRecord(
            chunk_id=f"{MANUAL_A}:5",
            mongo_id=None,
            manual_id=MANUAL_A,
            machine_model_id=MODEL_A,
            machine_id=None,
            chunk_index=5,
            page_start=3,
            page_end=3,
            section_title="Introduction",
            section_path=["Intro"],
            text="This manual describes routine lubrication of the conveyor bearings.",
            content_hash="hash-unrelated",
            manual_title="Hydraulic Service Manual",
            manual_version="2.1",
        ),
    ]


def chunk_vector(chunk: ChunkRecord) -> list[float]:
    """Tiny deterministic embedding used by the in-memory vector index."""
    text = chunk.text.lower()
    if "e-104" in text:
        return [1.0, 0.0, 0.0, 0.0]
    if "24 vdc" in text or "m12" in text:
        return [0.0, 0.0, 1.0, 0.0]
    return [0.0, 1.0, 0.0, 0.0]


class FakeEmbedder:
    async def ping(self) -> None:
        return None

    async def embed_query(self, text: str) -> list[float]:
        lowered = text.lower()
        if "e-104" in lowered or "e104" in lowered:
            return [1.0, 0.0, 0.0, 0.0]
        if "24 vdc" in lowered or "m12" in lowered or "supply voltage" in lowered:
            return [0.0, 0.0, 1.0, 0.0]
        return [0.0, 0.0, 0.0, 1.0]


def rag_runtime_config(**overrides: object) -> RagRuntimeConfig:
    weights = RankingWeights()
    kwargs: dict = {
        "top_k": 8,
        "min_context_chunks": 1,
        "min_semantic_score": 0.45,
        "min_final_score": 0.45,
        "require_source_metadata": True,
        "allow_unsupported_answer": False,
        "max_context_chars": 8000,
        "weights": weights,
        "expected_embedding_dimension": 4,
        "chat_model": "llama3.1",
        "embedding_model": "nomic-embed-text",
    }
    kwargs.update(overrides)
    return RagRuntimeConfig(**kwargs)  # type: ignore[arg-type]
