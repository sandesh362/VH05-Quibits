/**
 * Incident timeline - chronological, read-only.
 *
 * Backend timeline events are the backbone; technician actions and fix
 * records are merged in as clearly-labeled entries so the field view matches
 * the full audit story. Historical events are NEVER edited or filtered here.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMemo } from 'react';
import type { IncidentView } from '@itp/shared';
import { useAuth } from '@/auth/auth-context';
import { useIncident, useIncidentActions, useIncidentTimeline } from '@/hooks/queries';
import { CachedNotice, ErrorState, LoadingState } from '@/components/states';
import { TimelineEventRow } from '@/components/list-rows';
import { errorMessage } from '@/api/errors';
import { formatDateTime } from '@/lib/format';
import { colors, spacing } from '@/theme/tokens';

interface MergedEvent {
  key: string;
  at: string;
  node: React.ReactNode;
}

export default function TimelineScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const timeline = useIncidentTimeline(userId, incidentId);
  const actions = useIncidentActions(userId, incidentId);
  const incidentQuery = useIncident(userId, incidentId);
  const incident: IncidentView | undefined = incidentQuery.data?.data;

  const merged = useMemo<MergedEvent[]>(() => {
    const events: MergedEvent[] = [];
    for (const event of timeline.data?.data ?? []) {
      events.push({
        key: `t-${event.id}`,
        at: event.at,
        node: <TimelineEventRow event={event} />,
      });
    }
    for (const action of actions.data?.pages.flatMap((page) => page.items) ?? []) {
      events.push({
        key: `a-${action.id}`,
        at: action.performedAt,
        node: (
          <View>
            <Text style={styles.mergedLabel}>
              {action.actionType === 'assistant_suggestion' ? 'AI suggestion (recorded separately)' : 'Technician action'}
            </Text>
            <TimelineEventRow
              event={{
                id: action.id,
                sequence: 0,
                type: 'action_recorded',
                at: action.performedAt,
                actorId: action.performedBy,
                actorUsername: action.performedByName,
                note: action.result ? `Result: ${action.result}` : null,
              }}
            />
          </View>
        ),
      });
    }
    if (incident?.temporaryFix) {
      events.push({
        key: 'fix-temp',
        at: incident.temporaryFix.recordedAt,
        node: (
          <TimelineEventRow
            event={{
              id: 'fix-temp',
              sequence: 0,
              type: 'fix_recorded',
              at: incident.temporaryFix.recordedAt,
              actorId: null,
              actorUsername: null,
              note: `Temporary fix: ${incident.temporaryFix.description}`,
            }}
          />
        ),
      });
    }
    if (incident?.permanentFix) {
      events.push({
        key: 'fix-perm',
        at: incident.permanentFix.recordedAt,
        node: (
          <TimelineEventRow
            event={{
              id: 'fix-perm',
              sequence: 0,
              type: 'fix_recorded',
              at: incident.permanentFix.recordedAt,
              actorId: null,
              actorUsername: null,
              note: `Permanent fix: ${incident.permanentFix.description}`,
            }}
          />
        ),
      });
    }
    return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [timeline.data, actions.data, incident]);

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Timeline', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        {timeline.data?.cached ? <CachedNotice age="recent" /> : null}
        <Text style={styles.note}>Newest first · read-only audit view. Events can never be edited or removed.</Text>
        {timeline.isInitialLoading ? (
          <LoadingState label="Loading timeline…" />
        ) : timeline.isError && merged.length === 0 ? (
          <ErrorState message={errorMessage(timeline.error)} onRetry={() => void timeline.refetch()} />
        ) : merged.length === 0 ? (
          <Text style={styles.note}>No events recorded yet.</Text>
        ) : (
          merged.map((event) => (
            <View key={event.key}>
              <Text style={styles.day}>{formatDateTime(event.at)}</Text>
              {event.node}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  note: { color: colors.textSubtle, fontSize: 12, marginBottom: spacing.md },
  day: { color: colors.textSubtle, fontSize: 11, marginTop: spacing.sm, marginBottom: 2 },
  mergedLabel: { color: colors.textSubtle, fontSize: 11, marginBottom: 2 },
});
