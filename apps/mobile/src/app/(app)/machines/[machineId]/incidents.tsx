/**
 * All incidents for one machine (full list, filterable via My Work filters).
 */
import { FlatList, StyleSheet, Text } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useIncidents } from '@/hooks/queries';
import { EmptyState, ErrorState, SkeletonList } from '@/components/states';
import { IncidentRow } from '@/components/list-rows';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';
import type { IncidentView } from '@itp/shared';

export default function MachineIncidentsScreen(): React.JSX.Element {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const query = useIncidents(userId, { machineId, assignedToMe: false });

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Machine incidents', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <FlatList<IncidentView>
        data={query.data?.pages.flatMap((page) => page.items) ?? []}
        keyExtractor={(incident) => incident.id}
        contentContainerStyle={styles.content}
        refreshing={query.isRefetching}
        onRefresh={() => void query.refetch()}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
        }}
        renderItem={({ item }) => (
          <IncidentRow incident={item} onPress={() => router.push(`/(app)/incidents/${item.id}`)} />
        )}
        ListEmptyComponent={
          query.isInitialLoading ? (
            <SkeletonList rows={5} />
          ) : query.isError ? (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          ) : (
            <EmptyState title="No incidents" message="Nothing has been reported for this machine." />
          )
        }
        ListFooterComponent={query.isFetchingNextPage ? <Text style={styles.footer}>Loading more…</Text> : null}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  footer: { color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.md },
});
