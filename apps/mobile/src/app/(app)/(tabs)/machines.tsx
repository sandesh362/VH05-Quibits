/**
 * Machines tab - search and browse authorized machines.
 *
 * Searches the backend `search` filter (machine name, asset tag, serial
 * number) plus machine-model names (matching model → machines). Shows only
 * what the API returns for this user: no invented telemetry or status.
 */
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useMachines, useMachineModelSearch } from '@/hooks/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { TextField } from '@/components/ui';
import { EmptyState, ErrorState, SkeletonList } from '@/components/states';
import { MachineRow } from '@/components/list-rows';
import type { MachineView } from '@/api/types';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function MachinesScreen(): React.JSX.Element {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 350);

  const machineQuery = useMachines(userId, { search: debounced || undefined });
  // Model-name search is a second, cheap leg: a model match yields its machines.
  const modelQuery = useMachineModelSearch(userId, debounced);
  const [modelIdProbe, setModelIdProbe] = useState<string | null>(null);
  const probeQuery = useMachines(userId, modelIdProbe ? { machineModelId: modelIdProbe } : {});

  useEffect(() => {
    const modelHit = modelQuery.data?.items[0];
    setModelIdProbe(modelHit && debounced.length >= 2 ? modelHit.id : null);
  }, [modelQuery.data, debounced]);

  const byId = new Map<string, MachineView>();
  for (const machine of machineQuery.data?.pages.flatMap((page) => page.items) ?? []) byId.set(machine.id, machine);
  for (const machine of probeQuery.data?.pages.flatMap((page) => page.items) ?? []) byId.set(machine.id, machine);
  const machines = [...byId.values()];

  const error =
    (machineQuery.isError && !machineQuery.data ? machineQuery.error : null) ??
    (probeQuery.isError && !probeQuery.data ? probeQuery.error : null);

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Machines',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      />
      <FlatList<MachineView>
        data={machines}
        keyExtractor={(machine) => machine.id}
        contentContainerStyle={styles.content}
        refreshing={machineQuery.isRefetching}
        onRefresh={() => void machineQuery.refetch()}
        onEndReached={() => {
          if (machineQuery.hasNextPage && !machineQuery.isFetchingNextPage) void machineQuery.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.header}>
            <TextField
              label="Search"
              value={search}
              onChangeText={setSearch}
              placeholder="Name, code, serial or model…"
              autoCapitalize="none"
              testID="machine-search"
            />
            {modelIdProbe ? (
              <Text style={styles.modelNote}>Including machines of matching model.</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <MachineRow machine={item} onPress={() => router.push(`/(app)/machines/${item.id}`)} />
        )}
        ListEmptyComponent={
          machineQuery.isInitialLoading ? (
            <SkeletonList rows={6} />
          ) : error ? (
            <ErrorState message={errorMessage(error)} onRetry={() => void machineQuery.refetch()} />
          ) : (
            <EmptyState
              title="No machines found"
              message={
                search
                  ? 'No machine or model matches this search. Check the code with your supervisor.'
                  : 'No machines are authorized for your account yet.'
              }
            />
          )
        }
        ListFooterComponent={
          machineQuery.isFetchingNextPage ? <Text style={styles.footer}>Loading more…</Text> : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  header: { marginBottom: spacing.sm },
  modelNote: { color: colors.textSubtle, fontSize: 12, marginTop: -8, marginBottom: spacing.sm },
  footer: { color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.md },
});
