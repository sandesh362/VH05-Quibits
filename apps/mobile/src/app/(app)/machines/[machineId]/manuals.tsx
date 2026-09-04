/**
 * Manuals for a machine: machine-scoped + model-scoped, merged.
 * Processing status is shown honestly (only `completed` manuals are
 * searchable in the assistant). PDFs cannot be downloaded - the backend does
 * not expose file downloads by design; the manual reader shows extracted text.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useMachine, useManualsForMachine } from '@/hooks/queries';
import { Card, SectionTitle } from '@/components/ui';
import { CachedNotice, EmptyState, ErrorState, LoadingState } from '@/components/states';
import { ManualRow } from '@/components/list-rows';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function MachineManualsScreen(): React.JSX.Element {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const machineQuery = useMachine(userId, machineId);
  const manuals = useManualsForMachine(userId, machineQuery.data?.data);

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Manuals', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        {machineQuery.isInitialLoading ? (
          <LoadingState />
        ) : machineQuery.isError || !machineQuery.data?.data ? (
          <ErrorState message={errorMessage(machineQuery.error)} onRetry={() => void machineQuery.refetch()} />
        ) : (
          <>
            {manuals.data?.cached ? <CachedNotice age="recent" /> : null}
            <SectionTitle>
              {machineQuery.data.data.displayName ?? machineQuery.data.data.assetTag} — manuals
            </SectionTitle>
            <Card>
              <Text style={styles.note}>
                Manuals are read as extracted text. Original PDFs stay on the
                platform server; only machine- and model-scoped manuals for
                machines you are authorized to see are listed.
              </Text>
            </Card>
            {manuals.isInitialLoading ? (
              <LoadingState label="Loading manuals…" />
            ) : manuals.isError ? (
              <ErrorState message={errorMessage(manuals.error)} onRetry={() => void manuals.refetch()} />
            ) : (manuals.data?.data.length ?? 0) === 0 ? (
              <EmptyState title="No manuals" message="No manuals are registered for this machine or its model yet." />
            ) : (
              manuals.data?.data.map((manual) => (
                <ManualRow
                  key={manual.id}
                  manual={manual}
                  onPress={() => router.push(`/(app)/manuals/${manual.id}`)}
                />
              ))
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
  note: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
});
