/**
 * My Work - the technician's incident queue.
 *
 * Search + status/severity/priority filters, "assigned to me" toggle,
 * pull-to-refresh, infinite scroll. Shows exactly what the backend returns
 * for the signed-in user - nothing more.
 */
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useIncidents, type IncidentFilters } from '@/hooks/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Button, ChoiceGroup, TextField } from '@/components/ui';
import { EmptyState, ErrorState, PressableRow, SkeletonList } from '@/components/states';
import { IncidentRow } from '@/components/list-rows';
import { errorMessage } from '@/api/errors';
import { colors, spacing, type as typeScale } from '@/theme/tokens';
import type { IncidentView } from '@itp/shared';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'waiting_for_information', label: 'Wait info' },
  { value: 'waiting_for_parts', label: 'Wait parts' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'reopened', label: 'Reopened' },
  { value: 'closed', label: 'Closed' },
] as const;

const SEVERITY_OPTIONS = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

const PRIORITY_OPTIONS = [
  { value: '', label: 'Any priority' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

export default function WorkScreen(): React.JSX.Element {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [priority, setPriority] = useState('');
  const [assignedToMe, setAssignedToMe] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 350);

  const filters: IncidentFilters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      status: status || undefined,
      severity: severity || undefined,
      priority: priority || undefined,
      assignedToMe,
    }),
    [debouncedSearch, status, severity, priority, assignedToMe],
  );

  const query = useIncidents(userId, filters);
  const incidents = query.data?.pages.flatMap((page) => page.items) ?? [];
  const firstPageMeta = query.data?.pages[0]?.pagination;

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'My Work',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      />
      <FlatList<IncidentView>
        data={incidents}
        keyExtractor={(incident) => incident.id}
        contentContainerStyle={styles.content}
        refreshing={query.isRefetching}
        onRefresh={() => void query.refetch()}
        ListHeaderComponent={
          <View>
            <PressableRow
              onPress={() => setAssignedToMe((value) => !value)}
              accessibilityLabel={
                assignedToMe
                  ? 'Showing only incidents assigned to me. Tap to show all.'
                  : 'Showing all incidents. Tap to show only mine.'
              }
            >
              <View style={styles.toggleRow}>
                <Text style={styles.toggleText}>{assignedToMe ? '☑' : '☐'} Assigned to me</Text>
                <Button
                  label={showFilters ? 'Hide filters' : 'Filters'}
                  variant="ghost"
                  onPress={() => setShowFilters((value) => !value)}
                />
              </View>
            </PressableRow>
            <TextField
              label="Search"
              value={search}
              onChangeText={setSearch}
              placeholder="Title, description, error code…"
              autoCapitalize="none"
              testID="work-search"
            />
            {showFilters ? (
              <View style={styles.filters}>
                <ChoiceGroup
                  label="Status"
                  options={STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={status}
                  onChange={(value) => setStatus(value as string)}
                />
                <ChoiceGroup
                  label="Severity"
                  options={SEVERITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={severity}
                  onChange={(value) => setSeverity(value as string)}
                />
                <ChoiceGroup
                  label="Priority"
                  options={PRIORITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={priority}
                  onChange={(value) => setPriority(value as string)}
                />
              </View>
            ) : null}
            {firstPageMeta ? (
              <Text style={styles.count}>
                {firstPageMeta.total} incident{firstPageMeta.total === 1 ? '' : 's'}
              </Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <IncidentRow incident={item} onPress={() => router.push(`/(app)/incidents/${item.id}`)} />
        )}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          query.isInitialLoading ? (
            <SkeletonList rows={6} />
          ) : query.isError ? (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          ) : (
            <EmptyState
              title="No incidents match"
              message="Try clearing filters, or report a new incident from the Home tab."
              actionLabel="Clear filters"
              onAction={() => {
                setSearch('');
                setStatus('');
                setSeverity('');
                setPriority('');
                setAssignedToMe(false);
              }}
            />
          )
        }
        ListFooterComponent={
          query.isFetchingNextPage ? (
            <Text style={styles.footer}>Loading more…</Text>
          ) : query.isError && incidents.length > 0 ? (
            <View style={{ paddingBottom: spacing.lg }}>
              <ErrorState message="Could not load more. Check your connection." onRetry={() => void query.fetchNextPage()} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleText: { color: colors.text, fontSize: typeScale.body, fontWeight: '600' },
  filters: { marginTop: spacing.sm, marginBottom: spacing.sm },
  count: { color: colors.textSubtle, fontSize: typeScale.tiny, marginBottom: spacing.sm },
  footer: { color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.md },
});
