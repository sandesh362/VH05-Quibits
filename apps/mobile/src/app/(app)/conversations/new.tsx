/**
 * New conversation: machine selection is REQUIRED before any question (the
 * assistant answers machine/model-scoped questions only).
 */
import { StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useRecents } from '@/hooks/queries';
import { createConversation } from '@/api/endpoints';
import { can } from '@/lib/permissions';
import { Button, Card, SectionTitle } from '@/components/ui';
import { InlineBanner, LoadingState } from '@/components/states';
import { MachinePicker } from '@/components/forms';
import type { MachineView } from '@/api/types';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function NewConversationScreen(): React.JSX.Element {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const canAsk = can(user?.role, 'conversation.create');
  const recents = useRecents(userId, 'machines');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (target: MachineView) => {
    setBusy(true);
    setError(null);
    try {
      const conversation = await createConversation({ machineId: target.id, machineModelId: target.machineModelId || undefined });
      router.replace(`/(app)/conversations/${conversation.id}`);
    } catch (startError) {
      setError(errorMessage(startError));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'New conversation',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }}
      />
      <View style={styles.body}>
        {!canAsk ? (
          <Card>
            <InlineBanner tone="warn">
              Your role ({user?.role}) cannot start conversations.
            </InlineBanner>
          </Card>
        ) : (
          <>
            <SectionTitle>Which machine has the problem?</SectionTitle>
            <Card>
              <Text style={styles.bodyText}>
                The assistant answers only from manuals, history and maintenance
                records in scope for this machine and its model.
              </Text>
              {machine ? (
                <Text style={styles.machine}>
                  {machine.displayName ?? machine.assetTag}
                  {machine.modelSnapshot ? ` · ${machine.modelSnapshot.modelName}` : ''}
                </Text>
              ) : null}
              <View style={{ height: spacing.sm }} />
              <Button
                label={machine ? 'Start conversation' : 'Select machine'}
                onPress={() => (machine ? void start(machine) : setPickerVisible(true))}
                loading={busy}
                testID="new-conversation-start"
              />
              {recents.length > 0 ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Text style={styles.recentLabel}>Recent machines</Text>
                  {recents.slice(0, 4).map((recent) => (
                    <Button
                      key={recent.id}
                      label={`↺ ${recent.label}`}
                      variant="ghost"
                      onPress={() => setMachine({ id: recent.id, assetTag: recent.label, machineModelId: '' } as MachineView)}
                    />
                  ))}
                </View>
              ) : null}
              {error ? <InlineBanner tone="error">{error}</InlineBanner> : null}
            </Card>
            {busy ? <LoadingState label="Creating conversation…" /> : null}
          </>
        )}
      </View>
      <MachinePicker visible={pickerVisible} onClose={() => setPickerVisible(false)} onSelect={setMachine} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.md },
  bodyText: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  machine: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: spacing.sm },
  recentLabel: { color: colors.textMuted, fontSize: 12, marginBottom: 4 },
});
