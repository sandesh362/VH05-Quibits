/**
 * Manual reader.
 *
 * Metadata + honest processing status + extracted-text pages (backend
 * `GET /manuals/:id/pages`). The original PDF is not downloadable - the
 * platform never exposes file storage paths; this reader shows the same
 * extracted text the RAG pipeline is grounded on.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useManual, useManualPages } from '@/hooks/queries';
import { Badge, Button, Card, KeyValue } from '@/components/ui';
import { CachedNotice, EmptyState, ErrorState, InlineBanner, LoadingState } from '@/components/states';
import { processingStatus } from '@/lib/labels';
import { formatBytes, formatDateTime, pagesLabel } from '@/lib/format';
import { errorMessage } from '@/api/errors';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

export default function ManualDetailScreen(): React.JSX.Element {
  const { manualId } = useLocalSearchParams<{ manualId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const query = useManual(userId, manualId);
  const [page, setPage] = useState(1);
  const pages = useManualPages(userId, manualId, page);
  const manual = query.data?.data;

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Manual', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        {query.isInitialLoading ? (
          <LoadingState label="Loading manual…" />
        ) : query.isError || !manual ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <>
            {query.data?.cached ? <CachedNotice age="recent" /> : null}
            <Text style={styles.title} accessibilityRole="header">
              {manual.title}
            </Text>
            <View style={styles.badgeRow}>
              <Badge {...processingStatus(manual.processingStatus)} />
              {manual.isCurrentVersion ? null : <Badge icon="↓" label="Superseded" tone="neutral" />}
            </View>

            <Card>
              <KeyValue label="Version" value={manual.documentVersion ?? '—'} />
              <KeyValue label="Revision" value={manual.revision ?? '—'} />
              <KeyValue label="Document type" value={manual.documentType.replace(/_/g, ' ')} />
              <KeyValue label="Document number" value={manual.documentNumber ?? '—'} />
              <KeyValue label="Manufacturer" value={manual.manufacturer ?? '—'} />
              <KeyValue label="Scope" value={manual.scope === 'machine' ? 'This machine' : 'Machine model'} />
              <KeyValue label="Size" value={formatBytes(manual.fileSizeBytes)} />
              <KeyValue label="Pages" value={manual.pageCount ? String(manual.pageCount) : '—'} />
              <KeyValue label="Indexed chunks" value={String(manual.indexedChunkCount)} />
              <KeyValue label="Language" value={manual.language} />
              <KeyValue label="Uploaded" value={formatDateTime(manual.createdAt)} />
            </Card>

            {!manual.isSearchable ? (
              <InlineBanner tone="warn">
                This manual is not searchable yet ({processingStatus(manual.processingStatus).label}).
                {manual.failureReason ? ` Last failure: ${manual.failureReason}` : ''} The assistant
                cannot cite it until processing completes.
              </InlineBanner>
            ) : (
              <>
                <Text style={styles.readerTitle}>Extracted text</Text>
                {pages.isInitialLoading ? (
                  <LoadingState label="Loading pages…" />
                ) : pages.isError ? (
                  <ErrorState message={errorMessage(pages.error)} onRetry={() => void pages.refetch()} />
                ) : (pages.data?.items.length ?? 0) === 0 ? (
                  <EmptyState title="No extracted pages" message="This manual has no stored page text." />
                ) : (
                  (pages.data?.items ?? []).map((pageItem) => (
                    <Card key={pageItem.id}>
                      <Text style={styles.pageNumber}>
                        {pagesLabel(pageItem.pageNumber, pageItem.pageNumber)}
                        {pageItem.ocrUsed ? ' · OCR' : ''}
                      </Text>
                      <Text selectable style={styles.pageText}>
                        {pageItem.cleanedText || pageItem.rawText || '(empty page)'}
                      </Text>
                    </Card>
                  ))
                )}
                <View style={styles.pagerRow}>
                  <Button label="← Previous" variant="secondary" disabled={page <= 1} onPress={() => setPage((p) => Math.max(1, p - 1))} />
                  <Text style={styles.pageIndicator}>Page {page}</Text>
                  <Button
                    label="Next →"
                    variant="secondary"
                    disabled={!pages.data || page >= (pages.data.pagination.totalPages ?? 1)}
                    onPress={() => setPage((p) => p + 1)}
                  />
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  title: { color: colors.text, fontSize: typeScale.heading, fontWeight: '800', marginBottom: spacing.sm },
  badgeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  readerTitle: { color: colors.text, fontSize: typeScale.subheading, fontWeight: '700', marginBottom: spacing.sm },
  pageNumber: { color: colors.textSubtle, fontSize: typeScale.tiny, marginBottom: 4 },
  pageText: { color: colors.text, fontSize: typeScale.small, lineHeight: 21 },
  pagerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.sm },
  pageIndicator: { color: colors.textMuted, fontSize: typeScale.small },
});
