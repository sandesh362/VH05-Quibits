/**
 * Home - the field dashboard.
 *
 * Prioritizes the technician's own work: assigned queue counts, recent
 * incidents, recently opened machines, pending offline changes and quick
 * actions. No analytics, no admin dashboards.
 */
import { ScrollView, StyleSheet, View, Text, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useHomeOverview, useRecents, useSyncStatus } from '@/hooks/queries';
import { useNetwork } from '@/hooks/use-network';
import { useSyncEngine } from '@/hooks/use-sync';
import { Button, Card, SectionTitle, StatTile, Badge } from '@/components/ui';
import { PressableRow, EmptyState, ErrorState, LoadingState, SkeletonList } from '@/components/states';
import { IncidentRow } from '@/components/list-rows';
import { relativeTime } from '@/lib/format';
import { errorMessage } from '@/api/errors';
import { spacing, type as typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/theme-context';

const QUICK_ACTIONS = [
  { label: 'Ask Assistant', icon: '✦', route: '/(app)/(tabs)/assistant' },
  { label: 'Create Incident', icon: '★', route: '/(app)/incidents/create' },
  { label: 'Search Machines', icon: '⚙', route: '/(app)/(tabs)/machines' },
  { label: 'My Work', icon: '☑', route: '/(app)/(tabs)/work' },
] as const;

export default function HomeScreen(): React.JSX.Element {
  const { user } = useAuth();
  const { colors } = useTheme();
  const { isOnline } = useNetwork();
  const userId = user?.id ?? '';
  const overview = useHomeOverview(userId);
  const sync = useSyncStatus(userId, false);
  const recentMachines = useRecents(userId, 'machines');
  const { syncNow } = useSyncEngine(userId);
  const [refreshing, setRefreshing] = useState(false);

  const data = overview.data?.data;
  const firstName = (user?.fullName ?? 'there').split(' ')[0];

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await overview.refetch();
      await sync.refetch();
      await syncNow();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.primary} />}
      >
        <View style={[styles.hero, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eyebrow, { color: colors.primary }]}>Field dashboard</Text>
            <Text style={[styles.greeting, { color: colors.text }]}>Hi, {firstName}</Text>
            <Text style={[styles.role, { color: colors.textMuted }]} numberOfLines={1}>
              {user?.fullName} · {user?.role}
            </Text>
          </View>
          {!isOnline ? <Badge icon="⊘" label="Offline" tone="warn" /> : null}
        </View>

        <View style={styles.sectionHeader}>
          <SectionTitle>Your work</SectionTitle>
          <Text style={[styles.sectionHint, { color: colors.textSubtle }]}>Live queue</Text>
        </View>
        {overview.isInitialLoading ? (
          <SkeletonList rows={2} />
        ) : overview.isError && !data ? (
          <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />
        ) : (
          <View style={styles.statGrid}>
            <StatTile label="Assigned open" count={data?.assignedOpen ?? null} tone="warn" onPress={() => router.push('/(app)/(tabs)/work')} testID="home-open" />
            <StatTile label="Investigating" count={data?.investigating ?? null} tone="info" onPress={() => router.push('/(app)/(tabs)/work')} />
          </View>
        )}
        {overview.isError && data ? (
          <Text style={[styles.staleNote, { color: colors.warn }]}>Offline — counts are a saved copy.</Text>
        ) : null}
        {!overview.isError ? (
          <View style={styles.statGrid}>
            <StatTile label="Waiting for info" count={data?.waitingInfo ?? null} tone="neutral" onPress={() => router.push('/(app)/(tabs)/work')} />
            <StatTile label="Unresolved issues" count={data?.unresolvedIssues ?? null} tone="error" onPress={() => router.push('/(app)/(tabs)/work')} />
          </View>
        ) : null}

        <View style={styles.sectionHeader}>
          <SectionTitle>Quick actions</SectionTitle>
        </View>
        <View style={styles.quickGrid}>
          {QUICK_ACTIONS.map((action) => (
            <Button
              key={action.label}
              label={`${action.icon}  ${action.label}`}
              variant="secondary"
              onPress={() => router.push(action.route)}
              style={styles.quickButton}
            />
          ))}
        </View>

        <SectionTitle>Pending offline changes</SectionTitle>
        <Card>
          <Text style={[styles.syncLine, { color: colors.text }]}>
            {(sync.data?.pending ?? 0) + (sync.data?.review ?? 0) === 0
              ? 'Everything is synced.'
              : `${sync.data?.pending ?? 0} pending · ${sync.data?.review ?? 0} need review · ${sync.data?.failed ?? 0} failed`}
          </Text>
          <Text style={[styles.syncTime, { color: colors.textMuted }]}>Last sync: {relativeTime(sync.data?.lastSyncAt)}</Text>
          <View style={styles.syncActions}>
            <Button label="Sync now" variant="secondary" onPress={() => void syncNow()} loading={!isOnline ? false : undefined} disabled={!isOnline} />
            <Button label="Details" variant="ghost" onPress={() => router.push('/(app)/(tabs)/profile')} />
          </View>
        </Card>

        <SectionTitle>Recently created incidents</SectionTitle>
        {overview.isInitialLoading ? (
          <LoadingState label="Loading incidents…" />
        ) : data && data.recentIncidents.length > 0 ? (
          data.recentIncidents.map((incident) => (
            <IncidentRow
              key={incident.id}
              incident={incident}
              onPress={() => router.push(`/(app)/incidents/${incident.id}`)}
            />
          ))
        ) : (
          <EmptyState title="No recent incidents" message="Newly reported incidents across your organization will appear here." />
        )}

        {recentMachines.length > 0 ? (
          <>
            <SectionTitle>Recently opened machines</SectionTitle>
            {recentMachines.map((machine) => (
              <PressableRow
                key={machine.id}
                onPress={() => router.push(`/(app)/machines/${machine.id}`)}
                accessibilityLabel={`Open machine ${machine.label}`}
              >
                <View style={styles.recentRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: colors.text }]}>{machine.label}</Text>
                    {machine.subtitle ? <Text style={[styles.rowSub, { color: colors.textMuted }]}>{machine.subtitle}</Text> : null}
                  </View>
                  <Badge icon="⚙" label="Machine" tone="neutral" size="sm" testID={`recent-machine-${machine.id}`} />
                </View>
              </PressableRow>
            ))}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl + spacing.md },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  eyebrow: { fontSize: typeScale.tiny, fontWeight: '800', textTransform: 'uppercase', marginBottom: 4 },
  greeting: { fontSize: typeScale.title, fontWeight: '800' },
  role: { fontSize: typeScale.small, marginTop: 4 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  sectionHint: { fontSize: typeScale.tiny, fontWeight: '700' },
  statGrid: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.md },
  quickButton: { flexGrow: 1, minWidth: '45%', marginBottom: 0 },
  syncLine: { fontSize: typeScale.body, fontWeight: '700' },
  syncTime: { fontSize: typeScale.small, marginTop: 4, marginBottom: spacing.md },
  syncActions: { flexDirection: 'row', gap: spacing.md },
  staleNote: { fontSize: typeScale.tiny, marginBottom: spacing.sm },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { fontSize: typeScale.body, fontWeight: '600' },
  rowSub: { fontSize: typeScale.small },
});
