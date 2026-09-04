/**
 * Citation rendering with evidence lanes.
 *
 * Manual / Historical / Maintenance sources are visually distinct and always
 * carry their caption. Manual citations can open the exact stored chunk
 * (GET /manuals/:id/chunks/:chunkId - the same provenance the web uses);
 * historical citations deep-link to the referenced incident.
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Citation, EvidenceLane } from '@/lib/sources';
import { LANE_CAPTION, LANE_CHIP } from '@/lib/sources';
import { getManualChunk } from '@/api/endpoints';
import { errorMessage } from '@/api/errors';
import { colors, radius, spacing, toneBg, toneColor, type as typeScale } from '@/theme/tokens';
import { Button } from './ui';
import { LoadingState, InlineBanner } from './states';
import { formatDateTime, pagesLabel } from '@/lib/format';

const LANE_TONE: Record<EvidenceLane, keyof typeof toneColor> = {
  manual: 'ok',
  historical: 'warn',
  maintenance: 'info',
};

export function LaneChip({ lane }: { lane: EvidenceLane }): React.JSX.Element {
  const tone = LANE_TONE[lane];
  return (
    <View style={[styles.laneChip, { backgroundColor: toneBg[tone], borderColor: toneColor[tone] }]}>
      <Text style={{ color: toneColor[tone], fontSize: typeScale.tiny, fontWeight: '700' }}>{LANE_CHIP[lane]}</Text>
    </View>
  );
}

export function CitationCard({
  citation,
  onOpenIncident,
}: {
  citation: Citation;
  onOpenIncident?: (incidentId: string) => void;
}): React.JSX.Element {
  const [previewVisible, setPreviewVisible] = useState(false);
  const canOpenChunk = citation.lane === 'manual' && Boolean(citation.manualId && citation.chunkId);
  const canOpenIncident = citation.lane === 'historical' && Boolean(citation.incidentId && onOpenIncident);
  const pages = pagesLabel(citation.pageStart, citation.pageEnd);

  return (
    <View style={[styles.card, { borderColor: toneColor[LANE_TONE[citation.lane]] }]} accessibilityLabel={`${LANE_CHIP[citation.lane]} citation: ${citation.title}`}>
      <View style={styles.header}>
        <LaneChip lane={citation.lane} />
        {pages ? <Text style={styles.pages}>{pages}</Text> : null}
      </View>
      <Text style={styles.title}>{citation.title}</Text>
      {citation.version ? <Text style={styles.sub}>Version {citation.version}</Text> : null}
      {citation.sectionTitle ? <Text style={styles.sub}>{citation.sectionTitle}</Text> : null}
      {citation.lane === 'maintenance' && citation.daysBeforeIncident !== null ? (
        <Text style={styles.sub}>
          {citation.daysBeforeIncident} days before · correlation: {citation.correlationStrength ?? 'unknown'} · causal claim: NO
        </Text>
      ) : null}
      {citation.excerpt ? <Text style={styles.excerpt} numberOfLines={4}>{citation.excerpt}</Text> : null}
      <Text style={styles.caption}>{LANE_CAPTION[citation.lane]}</Text>
      <View style={styles.actions}>
        {canOpenChunk ? (
          <Button label="Open cited text" variant="secondary" onPress={() => setPreviewVisible(true)} />
        ) : null}
        {canOpenIncident ? (
          <Button label="View incident" variant="secondary" onPress={() => onOpenIncident?.(citation.incidentId as string)} />
        ) : null}
      </View>
      <ChunkPreviewModal
        visible={previewVisible}
        onClose={() => setPreviewVisible(false)}
        manualId={citation.manualId}
        chunkId={citation.chunkId}
        title={citation.title}
        pages={pages}
      />
    </View>
  );
}

function ChunkPreviewModal({
  visible,
  onClose,
  manualId,
  chunkId,
  title,
  pages,
}: {
  visible: boolean;
  onClose: () => void;
  manualId: string | null;
  chunkId: string | null;
  title: string;
  pages: string;
}): React.JSX.Element {
  const [state, setState] = useState<{ loading: boolean; error: string | null; text: string | null; section: string | null }>({
    loading: false,
    error: null,
    text: null,
    section: null,
  });

  const load = async () => {
    if (!manualId || !chunkId) return;
    setState({ loading: true, error: null, text: null, section: null });
    try {
      const chunk = await getManualChunk(manualId, chunkId);
      setState({
        loading: false,
        error: null,
        text: chunk.text,
        section: (chunk.sectionPath ?? []).join(' › ') || chunk.sectionTitle,
      });
    } catch (error) {
      setState({ loading: false, error: errorMessage(error), text: null, section: null });
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalScreen}>
        <Text style={styles.modalTitle}>Cited manual text</Text>
        <Text style={styles.modalSub}>
          {title}
          {pages ? ` · ${pages}` : ''}
        </Text>
        <Text style={styles.modalProvenance}>
          This is the exact stored text chunk the answer was grounded on. This deployment stores extracted text; page images are not part of the pipeline.
        </Text>
        {state.loading ? <LoadingState label="Loading cited text…" /> : null}
        {state.error ? <InlineBanner tone="error">{state.error}</InlineBanner> : null}
        {!state.loading && state.text === null && !state.error ? (
          <Button label="Load cited text" onPress={load} />
        ) : null}
        {state.text !== null ? (
          <ScrollView style={styles.scrollView}>
            {state.section ? <Text style={styles.sectionPath}>{state.section}</Text> : null}
            <Text selectable style={styles.chunkText}>
              {state.text}
            </Text>
          </ScrollView>
        ) : null}
        <Button label="Close" variant="secondary" onPress={onClose} style={{ marginTop: spacing.md }} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  laneChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  pages: { color: colors.textMuted, fontSize: typeScale.tiny },
  title: { color: colors.text, fontSize: typeScale.small, fontWeight: '700' },
  sub: { color: colors.textMuted, fontSize: typeScale.tiny, marginTop: 2 },
  excerpt: { color: colors.textMuted, fontSize: typeScale.tiny, marginTop: spacing.xs, fontStyle: 'italic' },
  caption: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  modalScreen: { flex: 1, backgroundColor: colors.bg, padding: spacing.md, paddingTop: spacing.xl },
  modalTitle: { color: colors.text, fontSize: typeScale.heading, fontWeight: '700' },
  modalSub: { color: colors.textMuted, fontSize: typeScale.small, marginTop: spacing.xs },
  modalProvenance: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.sm, marginBottom: spacing.md },
  scrollView: { flex: 1, marginTop: spacing.md },
  sectionPath: { color: colors.info, fontSize: typeScale.small, marginBottom: spacing.sm },
  chunkText: { color: colors.text, fontSize: typeScale.small, lineHeight: 22 },
});
