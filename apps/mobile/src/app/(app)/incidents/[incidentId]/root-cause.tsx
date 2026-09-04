/**
 * Root-cause workflow.
 *
 * suspected → confirmed / rejected, with mandatory notes, explicit user
 * action, and the server as final authority. Confirmations are never
 * automatic. Status history is shown read-only.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useIncident, useQueuedWrite, useRootCauseHistory } from '@/hooks/queries';
import { useSyncEngine } from '@/hooks/use-sync';
import { Button, Card, SectionTitle, TextField } from '@/components/ui';
import { ConfirmDialog } from '@/components/banners';
import { ModalShell } from '@/components/modal-shell';
import { CachedNotice, ErrorState, InlineBanner, LoadingState } from '@/components/states';
import { RootCauseCard } from '@/components/list-rows';
import { can, canAttempt } from '@/lib/permissions';
import { rootCauseStatus } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function RootCauseScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const incidentQuery = useIncident(userId, incidentId);
  const history = useRootCauseHistory(userId, incidentId);
  const queued = useQueuedWrite(userId);
  const { syncNow } = useSyncEngine(userId);
  const [mode, setMode] = useState<'update' | 'confirm' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const incident = incidentQuery.data?.data;
  const role = user?.role;
  const canUpdate = can(role, 'incident.root_cause_update');
  const canConfirm = canAttempt(role, 'confirmRootCause');

  const submit = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      let result;
      if (mode === 'update') {
        result = await queued.mutateAsync({ type: 'update_root_cause', payload: { incidentId, text, status: 'suspected' } });
      } else if (mode === 'confirm') {
        result = await queued.mutateAsync({
          type: 'confirm_root_cause',
          payload: { incidentId, note, text: text || undefined },
        });
      } else {
        result = await queued.mutateAsync({ type: 'reject_root_cause', payload: { incidentId, reason: note } });
      }
      if (result.kind === 'failed') {
        setError(result.op.lastError ?? 'The server rejected this change.');
        return;
      }
      if (result.kind === 'queued') {
        setError(null);
      }
      setMode(null);
      setNote('');
      setText('');
      await syncNow();
      void incidentQuery.refetch();
      void history.refetch();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Root cause', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        {incidentQuery.isInitialLoading ? (
          <LoadingState />
        ) : incidentQuery.isError || !incident ? (
          <ErrorState message={errorMessage(incidentQuery.error)} onRetry={() => void incidentQuery.refetch()} />
        ) : (
          <>
            {incidentQuery.data?.cached ? <CachedNotice age="recent" /> : null}
            <RootCauseCard
              rootCause={incident.rootCause}
              canUpdate={false}
              onUpdate={() => setMode('update')}
              onConfirm={() => setMode('confirm')}
              onReject={() => setMode('reject')}
            />
            {incident.rootCause.status === 'unknown' && canUpdate ? (
              <Button label="Set suspected root cause" onPress={() => setMode('update')} testID="rc-update" />
            ) : null}
            {incident.rootCause.status === 'suspected' && canConfirm ? (
              <View style={styles.buttonRow}>
                <Button label="Confirm root cause" onPress={() => setMode('confirm')} testID="rc-confirm" />
                <Button label="Reject" variant="danger" onPress={() => setMode('reject')} />
              </View>
            ) : null}
            {incident.rootCause.status === 'confirmed' ? (
              <InlineBanner tone="ok">
                Root cause confirmed {formatDateTime(incident.rootCause.confirmedAt)}. It can only be
                changed by an explicit rejection with a reason.
              </InlineBanner>
            ) : null}

            <SectionTitle>History</SectionTitle>
            {history.isInitialLoading ? (
              <LoadingState label="Loading history…" />
            ) : (history.data ?? []).length === 0 ? (
              <Text style={styles.hint}>No recorded changes yet.</Text>
            ) : (
              (history.data ?? []).map((entry, index) => (
                <Card key={index}>
                  <Text style={styles.historyStatus}>
                    {rootCauseStatus(String((entry as Record<string, unknown>).status ?? 'unknown')).label}
                  </Text>
                  {String((entry as Record<string, unknown>).text ?? '') ? (
                    <Text style={styles.body}>{String((entry as Record<string, unknown>).text)}</Text>
                  ) : null}
                  <Text style={styles.hint}>
                    {formatDateTime(String((entry as Record<string, unknown>).at ?? ''))}
                    {(entry as Record<string, unknown>).actorUsername
                      ? ` · ${String((entry as Record<string, unknown>).actorUsername)}`
                      : ''}
                  </Text>
                </Card>
              ))
            )}
          </>
        )}
      </ScrollView>

      <ModalShell
        title={mode === 'update' ? 'Set suspected root cause' : mode === 'confirm' ? 'Confirm root cause' : 'Reject root cause'}
        onClose={() => {
          setMode(null);
          setError(null);
        }}
      >
        {mode ? (
          <View>
            {mode === 'update' ? (
              <>
                <TextField
                  label="Suspected root cause"
                  value={text}
                  onChangeText={setText}
                  multiline
                  placeholder="Describe what you believe caused the fault"
                  testID="rc-text"
                />
                <InlineBanner tone="info">
                  This records a SUSPECTED cause. It is not a confirmation.
                </InlineBanner>
              </>
            ) : null}
            {mode === 'confirm' ? (
              <>
                <TextField label="Optional refined wording" value={text} onChangeText={setText} multiline placeholder="Leave empty to keep the current text" />
                <TextField
                  label="Confirmation note (required)"
                  value={note}
                  onChangeText={setNote}
                  multiline
                  placeholder="Why are you confident this is the root cause?"
                  testID="rc-note"
                />
                <InlineBanner tone="warn">
                  Confirming is an explicit engineering judgement that is audited under your name.
                </InlineBanner>
              </>
            ) : null}
            {mode === 'reject' ? (
              <TextField
                label="Rejection reason (required)"
                value={note}
                onChangeText={setNote}
                multiline
                placeholder="Why is this suspected cause wrong?"
                testID="rc-reject-reason"
              />
            ) : null}
            {error ? <InlineBanner tone="error">{error}</InlineBanner> : null}
            <View style={styles.buttonRow}>
              <Button
                label="Save"
                onPress={() => void submit()}
                loading={busy}
                disabled={busy}
                testID="rc-save"
              />
            </View>
          </View>
        ) : null}
      </ModalShell>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  hint: { color: colors.textSubtle, fontSize: 12 },
  body: { color: colors.textMuted, fontSize: 14, marginVertical: 2 },
  historyStatus: { color: colors.text, fontWeight: '600', fontSize: 14 },
});
