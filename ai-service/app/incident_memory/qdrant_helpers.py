"""Incident-memory helpers for Qdrant: deterministic point ids, payloads,
embedding text, and collection bootstrap for the SEPARATE incident_memory
collection (never mixed with manual chunk vectors)."""

from __future__ import annotations

import uuid
from typing import Any

from qdrant_client import models

INCIDENT_POINT_NAMESPACE = uuid.UUID("8c1d5f9e-2b3a-4c7d-9e01-a6b8c0d1e2f3")


def incident_point_id(incident_id: str, embedding_version: str) -> str:
    """Deterministic point id: uuid5(namespace, f'{incident_id}:{version}').

    Including the embedding version means a re-index with a new model produces
    different point ids, so blue/green re-indexing can coexist without a gap.
    Re-indexing with the same version overwrites in place (idempotent).
    """
    seed = f"{incident_id}:{embedding_version}"
    return str(uuid.uuid5(INCIDENT_POINT_NAMESPACE, seed))


def build_incident_embedding_text(incident: dict[str, Any]) -> str:
    """Deterministic embedding text.

    ONLY facts are embedded: machine model, error codes, symptoms, operating
    conditions, CONFIRMED root cause, CONFIRMED successful fix, resolution
    summary. Unconfirmed/suspected root causes, rejected root causes and
    unconfirmed fixes are deliberately excluded so unsupported assumptions are
    never embedded as facts.
    """
    sections: list[str] = []

    title = str(incident.get("title") or "").strip()
    number = str(incident.get("incident_number") or "").strip()
    if number or title:
        sections.append(f"Incident {number}: {title}".strip())

    error_codes = [str(c) for c in (incident.get("error_codes") or []) if str(c).strip()]
    if error_codes:
        sections.append("Error codes: " + ", ".join(error_codes))

    symptoms = [str(s) for s in (incident.get("symptoms") or []) if str(s).strip()]
    if symptoms:
        sections.append("Symptoms: " + "; ".join(symptoms))

    conditions = [
        str(c) for c in (incident.get("operating_conditions") or []) if str(c).strip()
    ]
    if conditions:
        sections.append("Operating conditions: " + "; ".join(conditions))

    confirmed_root_cause = str(incident.get("confirmed_root_cause") or "").strip()
    if confirmed_root_cause:
        sections.append(f"Confirmed root cause: {confirmed_root_cause}")

    confirmed_fix = str(incident.get("confirmed_fix") or "").strip()
    if confirmed_fix:
        sections.append(f"Confirmed successful fix: {confirmed_fix}")

    resolution_summary = str(incident.get("resolution_summary") or "").strip()
    if resolution_summary:
        sections.append(f"Resolution summary: {resolution_summary}")

    return "\n".join(sections).strip()


def build_incident_payload(
    incident: dict[str, Any],
    *,
    embedding_model: str,
    embedding_version: str,
) -> dict[str, Any]:
    """Qdrant payload for one incident point.

    Payload carries everything needed to render a similar-incident result and
    to enforce organization/machine-model isolation in the filter.
    """
    return {
        "incident_id": incident["incident_id"],
        "organization_id": incident["organization_id"],
        "machine_id": incident.get("machine_id") or None,
        "machine_model_id": incident.get("machine_model_id") or None,
        "incident_number": incident.get("incident_number") or "",
        "title": incident.get("title") or "",
        "source": incident.get("source") or "other",
        "status": incident.get("status") or "open",
        "issue_status": incident.get("issue_status") or "unknown",
        "severity": incident.get("severity") or "medium",
        "priority": incident.get("priority") or "medium",
        "error_codes": incident.get("error_codes") or [],
        "symptoms": incident.get("symptoms") or [],
        "operating_conditions": incident.get("operating_conditions") or [],
        "root_cause_status": incident.get("root_cause_status") or "unknown",
        "confirmed_root_cause": incident.get("confirmed_root_cause") or None,
        "confirmed_fix": incident.get("confirmed_fix") or None,
        "resolution_summary": incident.get("resolution_summary") or None,
        "resolved_at": incident.get("resolved_at") or None,
        "created_at": incident.get("created_at") or None,
        "tags": incident.get("tags") or [],
        "embedding_model": embedding_model,
        "embedding_version": embedding_version,
    }


def incident_filter(
    *,
    organization_id: str,
    machine_model_id: str | None,
    exclude_incident_id: str | None,
    embedding_model: str,
) -> models.Filter:
    """Mandatory organization filter; model filter when a model is in scope.

    Organization is ALWAYS a MUST condition so one organization's incident
    memory can never leak into another's retrieval, even if the embedding
    model or the Qdrant filter builder regresses.
    """
    must: list[models.FieldCondition] = [
        models.FieldCondition(
            key="organization_id", match=models.MatchValue(value=organization_id)
        ),
        models.FieldCondition(
            key="embedding_model", match=models.MatchValue(value=embedding_model)
        ),
    ]
    if machine_model_id:
        must.append(
            models.FieldCondition(
                key="machine_model_id", match=models.MatchValue(value=machine_model_id)
            )
        )
    if exclude_incident_id:
        must.append(
            models.FieldCondition(
                key="incident_id",
                match=models.MatchExcept(**{"except": [exclude_incident_id]}),
            )
        )
    return models.Filter(must=must)


INCIDENT_PAYLOAD_INDEX_FIELDS: list[tuple[str, models.PayloadSchemaType]] = [
    ("organization_id", models.PayloadSchemaType.KEYWORD),
    ("machine_id", models.PayloadSchemaType.KEYWORD),
    ("machine_model_id", models.PayloadSchemaType.KEYWORD),
    ("incident_id", models.PayloadSchemaType.KEYWORD),
    ("status", models.PayloadSchemaType.KEYWORD),
    ("issue_status", models.PayloadSchemaType.KEYWORD),
    ("root_cause_status", models.PayloadSchemaType.KEYWORD),
    ("error_codes", models.PayloadSchemaType.KEYWORD),
    ("embedding_model", models.PayloadSchemaType.KEYWORD),
]
