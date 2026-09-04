# Historical Evidence in RAG Answers

How Phase 6 integrates incident memory into the existing RAG pipeline
without letting history override manuals.

---

## 1. Pipeline flow (`ai-service/app/rag/pipeline.py`)

`PipelineRequest` gains `organization_id`; `PipelineDeps` gains the incident
store, collection, and history settings. During `retrieve()`:

1. Manual retrieval runs exactly as before (authoritative).
2. If the request carries an organization, the pipeline asks the incident
   memory for similar historical incidents
   (`INCIDENT_HISTORY_TOP_K`, score floor
   `INCIDENT_HISTORY_MIN_SEMANTIC_SCORE`, char cap
   `INCIDENT_HISTORY_MAX_CONTEXT_CHARS`).
3. Historical hits are rendered as a **supplementary evidence block** after
   the manual evidence — clearly separated and clearly secondary.

`organization_id` always originates from Express (resolved from the JWT
user); the AI service never guesses an org and never accepts one from an
untrusted caller.

## 2. The historical evidence block (`rag/context.py`)

`format_historical_evidence_block(hits)` produces a labelled block per hit:

- incident number/title/status,
- **confirmed root cause and confirmed fix** (only these are ever embedded),
- explicit marker that the source is historical and supplementary.

Block labels use the `HISTORICAL_INCIDENT_SOURCE` marker so the prompt rules
can recognise them.

## 3. Prompt rules (`rag/prompt.py`, rules 14–20)

- **Manual evidence is authoritative.** Historical incidents are
  supplementary context and must never outrank an OEM manual instruction.
- A historical incident **never proves** the current diagnosis: it may only
  be presented as "a similar past case", with its confirmed outcome clearly
  attributed to the past incident.
- The model must never prescribe a past incident's fix as the remedy for the
  current problem.
- Speculative/unconfirmed historical records must be labelled as such (only
  confirmed content is embedded, so this is a belt-and-braces rule).
- When citing history, cite the `history-N` sources that were actually
  retrieved.

Prompt version bumped to `rag-p6-v1` so cached/canary prompts are
distinguishable.

## 4. Citations (`rag/citations.py`)

- Historical hits are injected as source refs with ids `history-N`
  (alongside `source-N` manual refs).
- The citation validator accepts `history-N`; a generation that cites an
  unretrieved history id is still rejected.
- **No page numbers for historical sources.** Incident documents have no
  pages; historical refs use `page_start = 0 / page_end = 0`, and the
  prompt forbids page citations for historical sources.

## 5. Frontend surface

Message sources carry `sourceType` (`manual | historical`) and
`incidentNumber`; the chat UI can distinguish manual evidence from
historical context and link to the incident detail page.

## 6. Guardrails kept from Phase 5

- The evidence gate, clarification, refusal and conflict paths are
  unchanged — history is just another (secondary) input to the same gate.
- If incident retrieval fails (Qdrant/Ollama/Mongo down), answers proceed
  with manual evidence only and record a warning — history must never block
  a grounded answer.
