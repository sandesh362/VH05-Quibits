/**
 * Machine detail.
 *
 * Facts only, exactly what the backend supplies: identity, model snapshot,
 * location, criticality, backend-reported status and open-incident count.
 * No telemetry, no invented values.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEffect } from 'react';
import type { IncidentView } from '@itp/shared';
import { useAuth } from '@/auth/auth-context';
import { useIncidents, useMachine, markMachineVisited } from '@/hooks/queries';
import { Badge, Button, Card, KeyValue, SectionTitle } from '@/components/ui';
import { CachedNotice, EmptyState, ErrorState, LoadingState } from '@/components/states';
import { IncidentRow } from '@/components/list-rows';
import { machineStatus } from '@/lib/labels';
import { locationLabel, formatDate } from '@/lib/format';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function MachineDetailScreen(): React.JSX.Element {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const query = useMachine(userId, machineId);
  const machine = query.data?.data;
  const recentIncidents = useIncidents(userId, { machineId, assignedToMe: false });

  useEffect(() => {
    if (machine) markMachineVisited(userId, machine);
  }, [machine, userId]);

  const incidents: IncidentView[] = recentIncidents.data?.pages[0]?.items ?? [];

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: machine?.displayName ?? machine?.assetTag ?? 'Machine',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {query.isInitialLoading ? (
          <LoadingState label="Loading machine…" />
        ) : query.isError || !machine ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : (
          <>
            {query.data?.cached ? <CachedNotice age="recent" /> : null}
            <View style={styles.badgeRow}>
              <Badge {...machineStatus(machine.status)} />
              {machine.criticality ? (
                <Badge
                  icon={machine.criticality === 'critical' ? '⯅' : '◇'}
                  label={`${machine.criticality} criticality`}
                  tone={machine.criticality === 'critical' ? 'error' : 'neutral'}
                />
              ) : null}
              {machine.openIncidentCount > 0 ? (
                <Badge icon="!" label={`${machine.openIncidentCount} open`} tone="warn" />
              ) : null}
            </View>

            <Card>
              <KeyValue label="Name" value={machine.displayName ?? '—'} />
              <KeyValue label="Asset tag" value={machine.assetTag} />
              <KeyValue label="Serial number" value={machine.serialNumber ?? '—'} />
              <KeyValue
                label="Model"
                value={machine.modelSnapshot ? `${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName}` : machine.machineModelId}
              />
              {machine.modelSnapshot ? <KeyValue label="Type" value={machine.modelSnapshot.machineType.replace(/_/g, ' ')} /> : null}
              <KeyValue label="Location" value={locationLabel(machine.location) || '—'} />
              <KeyValue label="Installed" value={formatDate(machine.installedAt)} />
              <KeyValue label="Last maintenance" value={formatDate(machine.lastMaintenanceAt)} />
              {machine.notes ? (
                <>
                  <View style={{ height: spacing.sm }} />
                  <Text style={styles.notes}>{machine.notes}</Text>
                </>
              ) : null}
            </Card>

            <View style={styles.actionGrid}>
              <Button label="✦  Ask Assistant" onPress={() => router.push(`/(app)/machines/${machine.id}/assistant`)} style={styles.actionButton} testID="machine-ask" />
              <Button label="▤  Manuals" variant="secondary" onPress={() => router.push(`/(app)/machines/${machine.id}/manuals`)} style={styles.actionButton} />
              <Button label="★  Report incident" variant="secondary" onPress={() => router.push({ pathname: '/(app)/incidents/create', params: { machineId: machine.id } })} style={styles.actionButton} />
            </View>

            <SectionTitle>Recent incidents</SectionTitle>
            {recentIncidents.isInitialLoading ? (
              <LoadingState label="Loading incidents…" />
            ) : incidents.length > 0 ? (
              incidents.map((incident) => (
                <IncidentRow key={incident.id} incident={incident} onPress={() => router.push(`/(app)/incidents/${incident.id}`)} />
              ))
            ) : (
              <EmptyState title="No incidents on record" message="Historical incidents for this machine appear here." />
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
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  notes: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  actionButton: { flexGrow: 1, minWidth: '46%' },
});
