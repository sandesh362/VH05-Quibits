/**
 * Citation / evidence-lane mapping for assistant messages.
 *
 * The wire truth: `message.sources` holds the canonical manual citations, and
 * `message.structuredResponse.sources` holds the FULL per-lane source list as
 * produced by the RAG pipeline (`sourceType`: manual | incident | maintenance,
 * plus incident/maintenance metadata). We prefer the structured lanes and fall
 * back to `message.sources` when absent.
 *
 * Historical evidence is ALWAYS labeled as historical context; maintenance
 * records carry `causalClaim: false`. The UI never upgrades either lane into
 * manual authority.
 */
import type { MessageView } from '@itp/shared';

export type EvidenceLane = 'manual' | 'historical' | 'maintenance';

export interface Citation {
  key: string;
  lane: EvidenceLane;
  title: string;
  version: string | null;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  excerpt: string | null;
  /** Manual lane: open the stored chunk. */
  manualId: string | null;
  chunkId: string | null;
  /** Historical lane: the source IS a past incident; deep-linkable. */
  incidentId: string | null;
  incidentNumber: string | null;
  daysBeforeIncident: number | null;
  correlationStrength: string | null;
  causalClaim: boolean;
}

type RawSource = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function laneOf(sourceId: string, sourceType: unknown): EvidenceLane {
  if (sourceType === 'incident') return 'historical';
  if (sourceType === 'maintenance') return 'maintenance';
  if (sourceId.startsWith('history-')) return 'historical';
  if (sourceId.startsWith('maint-')) return 'maintenance';
  return 'manual';
}

function titleFor(lane: EvidenceLane, raw: RawSource, fallbackTitle: string): string {
  if (lane === 'historical') {
    const number = str(raw.incidentNumber);
    return number ? `Incident ${number}` : fallbackTitle;
  }
  return str(raw.manualTitle, fallbackTitle);
}

function fromRaw(raw: RawSource): Citation | null {
  const sourceId = str(raw.sourceId ?? raw.source_id);
  if (!sourceId) return null;
  const lane = laneOf(sourceId, raw.sourceType ?? raw.source_type);
  const manualId = str(raw.manualId ?? raw.manual_id) || null;
  const chunkId = str(raw.chunkId ?? raw.chunk_id) || null;
  return {
    key: sourceId,
    lane,
    title: titleFor(lane, raw, str(raw.manualTitle, 'Manual')),
    version: (raw.manualVersion ?? raw.manual_version ?? null) as string | null,
    pageStart: num(raw.pageStart ?? raw.page_start),
    pageEnd: num(raw.pageEnd ?? raw.page_end),
    sectionTitle: (raw.sectionTitle ?? raw.section_title ?? null) as string | null,
    excerpt: (raw.excerpt ?? null) as string | null,
    manualId: lane === 'manual' ? manualId : manualId,
    chunkId: lane === 'manual' ? chunkId : null,
    incidentId: lane === 'historical' ? chunkId : null,
    incidentNumber: lane === 'historical' ? str(raw.incidentNumber) || null : null,
    daysBeforeIncident:
      lane === 'maintenance'
        ? ((raw.daysBeforeIncident ?? raw.days_before_incident ?? null) as number | null)
        : null,
    correlationStrength:
      lane === 'maintenance'
        ? ((raw.correlationStrength ?? raw.correlation_strength ?? null) as string | null)
        : null,
    causalClaim: lane === 'maintenance' ? raw.causalClaim === true || raw.causal_claim === true : false,
  };
}

const LANE_ORDER: Record<EvidenceLane, number> = { manual: 0, historical: 1, maintenance: 2 };

/**
 * Build the citation list for an assistant message, manual lane first.
 * Returns [] for user/system messages.
 */
export function citationsOf(message: MessageView): Citation[] {
  if (message.role !== 'assistant') return [];

  const rawSources = (message.structuredResponse as { sources?: unknown } | null | undefined)?.sources;
  let citations: Citation[] = [];
  if (Array.isArray(rawSources) && rawSources.length > 0) {
    citations = rawSources
      .map((item) => (item && typeof item === 'object' ? fromRaw(item as RawSource) : null))
      .filter((item): item is Citation => item !== null);
  }
  if (citations.length === 0) {
    citations = message.sources
      .map((source) =>
        fromRaw({
          sourceId: source.sourceId,
          chunkId: source.chunkId,
          manualId: source.manualId,
          manualTitle: source.manualTitle,
          manualVersion: source.manualVersion,
          pageStart: source.pageStart,
          pageEnd: source.pageEnd,
          sectionTitle: source.sectionTitle,
          excerpt: source.excerpt,
        }),
      )
      .filter((item): item is Citation => item !== null);
  }

  const seen = new Set<string>();
  return citations
    .filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)))
    .sort((a, b) => LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || a.key.localeCompare(b.key));
}

export const LANE_CAPTION: Record<EvidenceLane, string> = {
  manual: 'Manual evidence — authoritative for this machine model.',
  historical: 'Historical context only. Similarity does not confirm that the current incident has the same root cause. Manual instructions remain authoritative.',
  maintenance: 'Maintenance record — noted context, never causally linked to this fault.',
};

export const LANE_CHIP: Record<EvidenceLane, string> = {
  manual: 'Manual',
  historical: 'Historical',
  maintenance: 'Maintenance',
};
