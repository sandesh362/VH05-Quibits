/**
 * Similar historical incidents.
 *
 * The disclaimer is permanent and non-collapsible: historical similarity is
 * context, never proof. Manual instructions remain authoritative.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useSimilarIncidents } from '@/hooks/queries';
import { Badge, Button, Card, Chip, KeyValue } from '@/components/ui';
import { CachedNotice, EmptyState, ErrorState, InlineBanner, LoadingState } from '@/components/states';
import { incidentStatus, issueStatus, rootCauseStatus, severity as severityPresentation } from '@/lib/labels';
import { errorMessage } from '@/api/errors';
import { formatDate } from '@/lib/format';
import { colors, spacing } from '@/theme/tokens';

export default function SimilarIncidentsScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const query = useSimilarIncidents(userId, incidentId);
  const similar = query.data?.data ?? [];

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Similar incidents', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        <InlineBanner tone="warn">
          Historical context only. Similarity does not confirm that the current
          incident has the same root cause. Manual instructions remain
          authoritative.
        </InlineBanner>
        {query.data?.cached ? <CachedNotice age="recent" /> : null}

        {query.isInitialLoading ? (
          <LoadingState label="Searching incident history…" />
        ) : query.isError ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : similar.length === 0 ? (
          <EmptyState
            title="No similar incidents found"
            message="Neither semantic memory nor error-code matching found comparable historical incidents."
          />
        ) : (
          similar.map((item) => (
            <Card key={item.incidentId}>
              <View style={styles.header}>
                <Badge {...severityPresentation(item.severity)} size="sm" />
                <Badge {...incidentStatus(item.status)} size="sm" />
                <Badge {...issueStatus(item.issueStatus)} size="sm" />
                {item.confirmed ? <Badge icon="✓" label="Confirmed RCA + fix" tone="ok" size="sm" /> : null}
              </View>
              <Text style={styles.number}>{item.incidentNumber}</Text>
              <Text style={styles.title}>{item.title}</Text>
              <KeyValue label="Date" value={formatDate(item.createdAt)} />
              {item.errorCodes.length > 0 ? (
                <View style={styles.chipWrap}>
                  {item.errorCodes.map((code) => <Chip key={code} label={code} tone="error" />)}
                </View>
              ) : null}
              {item.symptoms.length > 0 ? (
                <View style={styles.chipWrap}>
                  {item.symptoms.slice(0, 5).map((symptom) => <Chip key={symptom} label={symptom} />)}
                </View>
              ) : null}
              <KeyValue label="Root cause" value={item.confirmedRootCause ?? rootCauseStatus(item.rootCauseStatus).label} />
              {item.confirmedFix ? <KeyValue label="Confirmed fix" value={item.confirmedFix} /> : null}
              {item.resolutionSummary ? <KeyValue label="Resolution" value={item.resolutionSummary} /> : null}
              <KeyValue label="Matched because" value={item.similarityReasons.join(' · ') || 'similarity'} />
              <View style={{ height: spacing.sm }} />
              <Button
                label="Open incident"
                variant="secondary"
                onPress={() => router.push(`/(app)/incidents/${item.incidentId}`)}
              />
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  header: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  number: { color: colors.textSubtle, fontSize: 12, fontWeight: '700' },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: spacing.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.xs },
});
