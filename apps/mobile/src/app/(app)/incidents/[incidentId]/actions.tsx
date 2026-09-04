/**
 * Technician actions for an incident.
 *
 * Records what was actually DONE. Rules enforced here (mirroring the
 * backend): result statuses are only recordable for `technician` actions;
 * nothing is ever auto-confirmed - confirming an observed result is an
 * explicit human act with a note; AI suggestions appear only as
 * `assistant_suggestion` entries, never as technician work.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useIncidentActions, useQueuedWrite } from '@/hooks/queries';
import { useSyncEngine } from '@/hooks/use-sync';
import { Button, Card, ChoiceGroup, SectionTitle, TextField } from '@/components/ui';
import { ConfirmDialog } from '@/components/banners';
import { ModalShell } from '@/components/modal-shell';
import { CachedNotice, EmptyState, ErrorState, InlineBanner, SkeletonList } from '@/components/states';
import { IncidentActionRow } from '@/components/list-rows';
import { DateTimeField } from '@/components/forms';
import { canAttempt } from '@/lib/permissions';
import { actionResultStatus, actionSourceType } from '@/lib/labels';
import { ACTION_RESULT_STATUSES, INCIDENT_ACTION_SOURCE_TYPES } from '@itp/shared';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';
import { recordActionSchema } from '@/validation/schemas';

export default function IncidentActionsScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const query = useIncidentActions(userId, incidentId);
  const queued = useQueuedWrite(userId);
  const { syncNow } = useSyncEngine(userId);
  const [formVisible, setFormVisible] = useState(false);
  const [confirming, setConfirming] = useState<{ actionId: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);

  const actions = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Actions', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <ScrollView contentContainerStyle={styles.content}>
        {resultNote ? <InlineBanner tone={resultNote.startsWith('Saved') ? 'warn' : 'error'}>{resultNote}</InlineBanner> : null}

        <Button
          label="＋ Record an action"
          size="lg"
          onPress={() => setFormVisible(true)}
          testID="actions-record"
        />

        <SectionTitle>Recorded actions</SectionTitle>
        {query.isInitialLoading ? (
          <SkeletonList rows={3} />
        ) : query.isError && actions.length === 0 ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : actions.length === 0 ? (
          <EmptyState title="No actions yet" message="Record inspections, adjustments and part replacements as you perform them." />
        ) : (
          actions.map((action) => (
            <IncidentActionRow
              key={action.id}
              action={action}
              onConfirm={canAttempt(user?.role, 'confirmAction') ? () => setConfirming({ actionId: action.id }) : undefined}
            />
          ))
        )}
      </ScrollView>

      <ActionFormDialog
        visible={formVisible}
        close={() => {
          setFormVisible(false);
          setFormError(null);
        }}
        incidentId={incidentId}
        busy={queued.isPending}
        onSubmit={async (payload, reset) => {
          setFormError(null);
          try {
            const result = await queued.mutateAsync({ type: 'create_action', payload });
            if (result.kind === 'completed') {
              reset();
              setFormVisible(false);
              setResultNote('Action recorded.');
            } else if (result.kind === 'queued') {
              reset();
              setFormVisible(false);
              setResultNote('Saved offline. It syncs when you are connected — it is NOT recorded yet.');
            } else if (result.kind === 'failed') {
              setFormError(result.op.lastError ?? 'The server rejected this action.');
            } else {
              reset();
              setFormVisible(false);
              setResultNote('The server did not confirm this action. Review it in Profile → Queued changes.');
            }
            await syncNow();
            void query.refetch();
          } catch (error) {
            setFormError(errorMessage(error));
          }
        }}
      />

      <ConfirmActionDialog
        confirming={confirming}
        close={() => setConfirming(null)}
        incidentId={incidentId}
        userId={userId}
        queued={queued}
        onDone={() => void query.refetch()}
      />
    </SafeAreaView>
  );
}

function ActionFormDialog({
  visible,
  close,
  incidentId,
  busy,
  onSubmit,
}: {
  visible: boolean;
  close: () => void;
  incidentId: string;
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>, reset: () => void) => Promise<void>;
}): React.JSX.Element {
  const [actionType, setActionType] = useState<(typeof INCIDENT_ACTION_SOURCE_TYPES)[number]>('technician');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState('');
  const [resultStatus, setResultStatus] = useState<(typeof ACTION_RESULT_STATUSES)[number]>('not_tested');
  const [notes, setNotes] = useState('');
  const [performedAt, setPerformedAt] = useState<string | undefined>(undefined);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!visible) return <View />;

  const reset = () => {
    setActionType('technician');
    setDescription('');
    setResult('');
    setResultStatus('not_tested');
    setNotes('');
    setPerformedAt(undefined);
    setLocalError(null);
  };

  const submit = async () => {
    const parsed = recordActionSchema.safeParse({
      actionType,
      description,
      result: result || undefined,
      resultStatus,
      notes: notes || undefined,
      performedAt,
    });
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? 'Check the form.');
      return;
    }
    await onSubmit(
      {
        incidentId,
        body: {
          actionType,
          description: parsed.data.description,
          result: parsed.data.result,
          resultStatus: actionType === 'technician' ? resultStatus : 'not_tested',
          notes: parsed.data.notes,
          performedAt: parsed.data.performedAt ?? new Date().toISOString(),
        },
      },
      reset,
    );
  };

  return (
    <ModalShell title="Record an action" onClose={close}>
      <ChoiceGroup
        label="Action type"
        options={INCIDENT_ACTION_SOURCE_TYPES.map((value) => ({
          value,
          label: actionSourceType(value).label,
          icon: actionSourceType(value).icon,
        }))}
        value={actionType}
        onChange={(value) => setActionType(value)}
      />
      <TextField
        label="What did you do?"
        value={description}
        onChangeText={setDescription}
        multiline
        placeholder="e.g. Cleaned the suction strainer and replaced the O-ring"
      />
      {actionType === 'technician' ? (
        <>
          <ChoiceGroup
            label="Observed result"
            options={ACTION_RESULT_STATUSES.map((value) => ({
              value,
              label: actionResultStatus(value).label,
              icon: actionResultStatus(value).icon,
              tone: actionResultStatus(value).tone,
            }))}
            value={resultStatus}
            onChange={(value) => setResultStatus(value)}
          />
          <TextField label="Result details" value={result} onChangeText={setResult} multiline placeholder="What changed after the action?" />
        </>
      ) : (
        <InlineBanner tone="info">
          Result statuses apply to technician actions only. AI suggestions are
          recorded for traceability — they are never marked as performed work.
        </InlineBanner>
      )}
      <TextField label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="Optional" />
      <DateTimeField label="Performed at" value={performedAt} onChange={setPerformedAt} />
      {localError ? <InlineBanner tone="error">{localError}</InlineBanner> : null}
      <View style={styles.dialogActions}>
        <Button label="Cancel" variant="secondary" onPress={close} disabled={busy} />
        <Button label="Save action" onPress={() => void submit()} loading={busy} testID="action-save" />
      </View>
    </ModalShell>
  );
}

function ConfirmActionDialog({
  confirming,
  close,
  incidentId,
  userId,
  queued,
  onDone,
}: {
  confirming: { actionId: string } | null;
  close: () => void;
  incidentId: string;
  userId: string;
  queued: ReturnType<typeof useQueuedWrite>;
  onDone: () => void;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!confirming) return <View />;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await queued.mutateAsync({
        type: 'confirm_action',
        payload: { incidentId, actionId: confirming.actionId, note },
      });
      if (result.kind === 'completed') {
        close();
      } else if (result.kind === 'queued') {
        close();
      } else if (result.kind === 'failed') {
        setError(result.op.lastError ?? 'The server rejected this confirmation.');
        return;
      } else {
        close();
      }
      onDone();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      visible
      title="Confirm this action result?"
      message="Confirmation states that you observed this result yourself. The server keeps the authoritative audit trail."
      confirmLabel="Confirm result"
      loading={busy}
      onCancel={close}
      onConfirm={() => void confirm()}
    >
      <TextField label="Confirmation note (required)" value={note} onChangeText={setNote} multiline />
      {error ? <InlineBanner tone="error">{error}</InlineBanner> : null}
    </ConfirmDialog>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  dialogActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
});
