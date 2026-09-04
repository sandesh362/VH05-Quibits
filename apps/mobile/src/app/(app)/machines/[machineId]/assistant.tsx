/**
 * Ask the assistant about THIS machine.
 *
 * Finds the technician's active conversation for the machine or creates one,
 * then routes into the chat. Requires conversation.create - viewers are
 * told plainly that they cannot ask questions.
 */
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/auth/auth-context';
import { useMachine } from '@/hooks/queries';
import { can } from '@/lib/permissions';
import { createConversation, listConversations } from '@/api/endpoints';
import { errorMessage } from '@/api/errors';
import { Button, Card } from '@/components/ui';
import { ErrorState, InlineBanner } from '@/components/states';
import { colors, spacing } from '@/theme/tokens';

export default function MachineAssistantScreen(): React.JSX.Element {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const machineQuery = useMachine(userId, machineId);
  const canAsk = can(user?.role, 'conversation.create');
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const startedRef = useRef(false);

  const existing = useQuery({
    queryKey: ['machine-active-conversation', machineId],
    enabled: Boolean(userId && machineId && canAsk && status === 'idle'),
    staleTime: 0,
    queryFn: () => listConversations({ machineId, status: 'active', limit: 1 }),
    retry: false,
  });

  useEffect(() => {
    if (!canAsk || startedRef.current || status !== 'idle') return;
    if (existing.isInitialLoading) return;
    startedRef.current = true;
    setStatus('working');
    (async () => {
      try {
        const active = existing.data?.items[0];
        if (active) {
          router.replace(`/(app)/conversations/${active.id}`);
          return;
        }
        const created = await createConversation({ machineId });
        router.replace(`/(app)/conversations/${created.id}`);
      } catch {
        setStatus('done');
      }
    })();
  }, [canAsk, existing.data, existing.isInitialLoading, machineId, status]);

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Assistant', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <View style={styles.body}>
        {!canAsk ? (
          <Card>
            <InlineBanner tone="warn">
              Your role ({user?.role}) cannot start conversations. Ask your
              administrator for the technician role to use the assistant.
            </InlineBanner>
            <Button label="Back" variant="secondary" onPress={() => router.back()} />
          </Card>
        ) : status === 'done' ? (
          <ErrorState
            message={errorMessage(existing.error) || 'Could not open a conversation.'}
            onRetry={() => {
              startedRef.current = false;
              setStatus('idle');
              void existing.refetch();
            }}
          />
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.loadingText}>
              {machineQuery.data?.data.displayName ?? 'Machine'} — opening the troubleshooting assistant…
            </Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.md },
  loading: { alignItems: 'center', marginTop: spacing.xl, gap: spacing.md },
  loadingText: { color: colors.textMuted, textAlign: 'center' },
});
