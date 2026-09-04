/**
 * Temporary / permanent fix workflow.
 *
 * record → confirm, with mandatory confirmation notes and explicit user
 * action. Confirming the permanent fix (with a confirmed root cause) is what
 * resolves an incident server-side - the app never resolves anything itself.
 */
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useIncident, useQueuedWrite } from '@/hooks/queries';
import { useSyncEngine } from '@/hooks/use-sync';
import { Button, Card, SectionTitle, TextField } from '@/components/ui';
import { ModalShell } from '@/components/modal-shell';
import { CachedNotice, ErrorState, InlineBanner, LoadingState } from '@/components/states';
import { FixCard } from '@/components/list-rows';
import { can, canAttempt } from '@/lib/permissions';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';
import { fixRecordSchema } from '@/validation/schemas';

type FixKind = 'temporary' | 'permanent';
type Mode = { kind: FixKind; action: 'record' | 'confirm' } | null;

export default function FixesScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const incidentQuery = useIncident(userId, incidentId);
  const queued = useQueuedWrite(userId);
  const { syncNow } = useSyncEngine(userId);
  const [mode, setMode] = useState<Mode>(null);
  const [description, setDescription] = useState('');
  const [result, setResult] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const incident = incidentQuery.data?.data;
  const role = user?.role;
  const canRecord = can(role, 'incident.fix_record');
  const canConfirm = canAttempt(role, 'confirmTemporaryFix');

  const openMode = (next: Mode) => {
    setDescription('');
    setResult('');
    setNote('');
    setError(null);
    setMode(next);
  };

  const submit = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      if (mode.action === 'record') {
        const parsed = fixRecordSchema.safeParse({ description, result: result || undefined });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Check the form.');
          return;
        }
        const op = mode.kind === 'temporary' ? 'record_temporary_fix' : 'record_permanent_fix';
        const outcome = await queued.mutateAsync({
          type: op,
          payload: {
            incidentId,
            description: parsed.data.description,
            result: parsed.data.result,
          },
        });
        if (outcome.kind === 'failed') {
          setError(outcome.op.lastError ?? 'The server rejected this fix.');
          return;
        }
        if (outcome.kind === 'queued') {
          Alert.alert('Saved offline', 'The fix record syncs when you are connected — it is not recorded yet.');
        }
      } else {
        if (note.trim().length < 3) {
          setError('A confirmation note is required (at least 3 characters).');
          return;
        }
        const op = mode.kind === 'temporary' ? 'confirm_temporary_fix' : 'confirm_permanent_fix';
        const outcome = await queued.mutateAsync({
          type: op,
          payload: { incidentId, note, result: result || undefined },
        });
        if (outcome.kind === 'failed') {
          setError(outcome.op.lastError ?? 'The server rejected this confirmation.');
          return;
        }
        if (outcome.kind === 'queued') {
          Alert.alert('Saved offline', 'The confirmation syncs when you are connected — it is not confirmed yet.');
        }
      }
      setMode(null);
      await syncNow();
      void incidentQuery.refetch();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Fixes', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        {incidentQuery.isInitialLoading ? (
          <LoadingState />
        ) : incidentQuery.isError || !incident ? (
          <ErrorState message={errorMessage(incidentQuery.error)} onRetry={() => void incidentQuery.refetch()} />
        ) : (
          <>
            {incidentQuery.data?.cached ? <CachedNotice age="recent" /> : null}
            <FixCard
              kind="Temporary fix"
              fix={incident.temporaryFix}
              canRecord={canRecord}
              canConfirm={canConfirm}
              onRecord={() => openMode({ kind: 'temporary', action: 'record' })}
              onConfirm={() => openMode({ kind: 'temporary', action: 'confirm' })}
            />
            <FixCard
              kind="Permanent fix"
              fix={incident.permanentFix}
              canRecord={canRecord}
              canConfirm={canAttempt(role, 'confirmPermanentFix')}
              onRecord={() => openMode({ kind: 'permanent', action: 'record' })}
              onConfirm={() => openMode({ kind: 'permanent', action: 'confirm' })}
            />
            <InlineBanner tone="info">
              Confirming the permanent fix while the root cause is confirmed
              resolves the incident on the server. Nothing resolves automatically.
            </InlineBanner>
            {incident.temporaryFix ? (
              <SectionTitle>Labels</SectionTitle>
            ) : null}
            {incident.temporaryFix ? (
              <Text style={styles.labelLine}>
                Temporary fix: {incident.temporaryFix.status === 'confirmed' ? 'CONFIRMED' : incident.temporaryFix.status === 'rejected' ? 'REJECTED' : 'RECORDED (unconfirmed)'}
              </Text>
            ) : null}
            {incident.permanentFix ? (
              <Text style={styles.labelLine}>
                Permanent fix: {incident.permanentFix.status === 'confirmed' ? 'CONFIRMED' : incident.permanentFix.status === 'rejected' ? 'REJECTED' : 'RECORDED (unconfirmed)'}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>

      <ModalShell
        title={
          mode
            ? `${mode.action === 'record' ? 'Record' : 'Confirm'} ${mode.kind} fix`
            : ''
        }
        onClose={() => setMode(null)}
      >
        {mode ? (
          <View>
            {mode.action === 'record' ? (
              <>
                <TextField
                  label="What was done?"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  placeholder="Describe the fix"
                  testID="fix-description"
                />
                <TextField label="Result so far" value={result} onChangeText={setResult} multiline placeholder="Optional" />
              </>
            ) : (
              <>
                <TextField
                  label="Confirmation note (required)"
                  value={note}
                  onChangeText={setNote}
                  multiline
                  placeholder="How did you verify this fix holds?"
                  testID="fix-note"
                />
                <TextField label="Verified result" value={result} onChangeText={setResult} multiline placeholder="Optional" />
              </>
            )}
            {error ? <InlineBanner tone="error">{error}</InlineBanner> : null}
            <Button
              label={mode.action === 'record' ? 'Save fix' : 'Confirm fix'}
              onPress={() => void submit()}
              loading={busy}
              testID="fix-save"
            />
          </View>
        ) : null}
      </ModalShell>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  labelLine: { color: colors.textMuted, fontSize: 13, marginBottom: 4 },
});
