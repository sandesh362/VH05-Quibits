/**
 * Incident detail.
 *
 * Shows the full record; lifecycle actions are offered only where the
 * server-side policy could accept them (capability mirror + attempt rules),
 * with a confirmation dialog for every important state change. Lifecycle
 * writes go through the outbox (offline-capable); the server stays the
 * authority. Cancellation (DELETE with reason) needs a live connection and is
 * therefore executed directly, never queued.
 */
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useIncident, markIncidentVisited, useQueuedWrite, type QueuedWriteResult } from '@/hooks/queries';
import { useSyncEngine } from '@/hooks/use-sync';
import { Badge, Button, Card, Chip, KeyValue, SectionTitle } from '@/components/ui';
import { ConfirmDialog } from '@/components/banners';
import { CachedNotice, ErrorState, InlineBanner, LoadingState } from '@/components/states';
import { FixCard, RootCauseCard } from '@/components/list-rows';
import { can, canAttempt, type Attempt } from '@/lib/permissions';
import { incidentStatus, issueStatus, priority as priorityPresentation, severity as severityPresentation } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { cancelIncident } from '@/api/endpoints';
import { errorMessage } from '@/api/errors';
import { ISSUE_STATUS_TRANSITIONS, INCIDENT_STATUS_TRANSITIONS } from '@/lib/lifecycle';
import { CONFIRMED_ISSUE_STATUSES, type IncidentStatus, type IssueStatus } from '@itp/shared';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

type Dialog =
  | { kind: 'status'; to: IncidentStatus }
  | { kind: 'issueStatus'; to: IssueStatus; needsNote: boolean }
  | { kind: 'close' }
  | { kind: 'reopen' }
  | { kind: 'cancel' }
  | null;

export default function IncidentDetailScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const incidentQuery = useIncident(userId, incidentId);
  const { syncNow } = useSyncEngine(userId);
  const queued = useQueuedWrite(userId);
  const incident = incidentQuery.data?.data;
  const cached = incidentQuery.data?.cached ?? false;
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    if (incident) markIncidentVisited(userId, incident);
  }, [incident, userId]);

  if (incidentQuery.isInitialLoading) {
    return (
      <SafeAreaView style={styles.screen} edges={['bottom']}>
        <Stack.Screen options={{ headerShown: true, title: 'Incident', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
        <LoadingState label="Loading incident…" />
      </SafeAreaView>
    );
  }
  if (incidentQuery.isError || !incident) {
    return (
      <SafeAreaView style={styles.screen} edges={['bottom']}>
        <Stack.Screen options={{ headerShown: true, title: 'Incident', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
        <ErrorState message={errorMessage(incidentQuery.error)} onRetry={() => void incidentQuery.refetch()} />
      </SafeAreaView>
    );
  }

  const role = user?.role;
  const canUpdate = can(role, 'incident.update_any') || can(role, 'incident.update_own');
  const attempt = (name: Attempt) => canAttempt(role, name);

  const statusOptions = INCIDENT_STATUS_TRANSITIONS[incident.status];
  const issueOptions = ISSUE_STATUS_TRANSITIONS[incident.issueStatus];

  const navButtons = [
    { label: '⏱ Timeline', route: `/(app)/incidents/${incident.id}/timeline` },
    { label: '🔧 Actions', route: `/(app)/incidents/${incident.id}/actions` },
    { label: '⌕ Similar incidents', route: `/(app)/incidents/${incident.id}/similar` },
    { label: '∼ Root cause', route: `/(app)/incidents/${incident.id}/root-cause` },
    { label: '✚ Fixes', route: `/(app)/incidents/${incident.id}/fixes` },
  ];

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: incident.incidentNumber,
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {cached ? <CachedNotice age="recent" /> : null}

        <View style={styles.badgeRow}>
          <Badge {...severityPresentation(incident.severity)} />
          <Badge {...priorityPresentation(incident.priority)} />
          <Badge {...incidentStatus(incident.status)} />
          <Badge {...issueStatus(incident.issueStatus)} />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          {incident.title}
        </Text>

        <Card>
          <KeyValue label="Incident" value={incident.incidentNumber} />
          <KeyValue
            label="Machine"
            value={incident.machineId ? (incident.machineLabel ?? 'View machine') : '—'}
          />
          <KeyValue label="Model" value={incident.machineModelLabel ?? incident.machineModelId} />
          <KeyValue label="Reported by" value={incident.reportedByName ?? incident.reportedBy} />
          <KeyValue label="Assigned to" value={incident.assignedToName ?? (incident.assignedTo ?? 'Unassigned')} />
          <KeyValue label="First observed" value={formatDateTime(incident.firstObservedAt)} />
          <KeyValue label="Created" value={formatDateTime(incident.createdAt)} />
          <KeyValue label="Updated" value={formatDateTime(incident.updatedAt)} />
          <View style={{ height: spacing.sm }} />
          {incident.machineId ? (
            <Button label="Open machine" variant="secondary" onPress={() => router.push(`/(app)/machines/${incident.machineId}`)} />
          ) : null}
        </Card>

        <Card>
          <Text style={styles.cardHeading}>Description</Text>
          <Text style={styles.body}>{incident.description}</Text>
        </Card>

        {incident.symptoms.length > 0 ? (
          <Card>
            <Text style={styles.cardHeading}>Symptoms</Text>
            <View style={styles.chipWrap}>
              {incident.symptoms.map((symptom) => <Chip key={symptom} label={symptom} />)}
            </View>
          </Card>
        ) : null}
        {incident.errorCodes.length > 0 ? (
          <Card>
            <Text style={styles.cardHeading}>Error codes</Text>
            <View style={styles.chipWrap}>
              {incident.errorCodes.map((code) => <Chip key={code} label={code} tone="error" />)}
            </View>
          </Card>
        ) : null}
        {incident.operatingConditions.length > 0 ? (
          <Card>
            <Text style={styles.cardHeading}>Operating conditions</Text>
            <View style={styles.chipWrap}>
              {incident.operatingConditions.map((condition) => <Chip key={condition} label={condition} />)}
            </View>
          </Card>
        ) : null}
        {incident.tags.length > 0 ? (
          <Card>
            <Text style={styles.cardHeading}>Tags</Text>
            <View style={styles.chipWrap}>
              {incident.tags.map((tag) => <Chip key={tag} label={tag} tone="info" />)}
            </View>
          </Card>
        ) : null}

        <SectionTitle>Investigation</SectionTitle>
        <RootCauseCard
          rootCause={incident.rootCause}
          canUpdate={canUpdate}
          onUpdate={() => router.push(`/(app)/incidents/${incident.id}/root-cause`)}
          onConfirm={() => router.push(`/(app)/incidents/${incident.id}/root-cause`)}
          onReject={() => router.push(`/(app)/incidents/${incident.id}/root-cause`)}
        />
        <FixCard
          kind="Temporary fix"
          fix={incident.temporaryFix}
          canRecord={can(role, 'incident.fix_record')}
          canConfirm={attempt('confirmTemporaryFix')}
          onRecord={() => router.push(`/(app)/incidents/${incident.id}/fixes`)}
          onConfirm={() => router.push(`/(app)/incidents/${incident.id}/fixes`)}
        />
        <FixCard
          kind="Permanent fix"
          fix={incident.permanentFix}
          canRecord={can(role, 'incident.fix_record')}
          canConfirm={attempt('confirmPermanentFix')}
          onRecord={() => router.push(`/(app)/incidents/${incident.id}/fixes`)}
          onConfirm={() => router.push(`/(app)/incidents/${incident.id}/fixes`)}
        />
        {incident.resolutionSummary ? (
          <Card>
            <Text style={styles.cardHeading}>Resolution summary</Text>
            <Text style={styles.body}>{incident.resolutionSummary}</Text>
            <Text style={styles.hint}>Closed {formatDateTime(incident.closedAt)}</Text>
          </Card>
        ) : null}

        {incident.conversationId || incident.manualId ? (
          <Card>
            <Text style={styles.cardHeading}>Linked records</Text>
            {incident.conversationId ? (
              <Button
                label="Open linked conversation"
                variant="secondary"
                onPress={() => router.push(`/(app)/conversations/${incident.conversationId}`)}
              />
            ) : null}
            {incident.conversationId && incident.manualId ? <View style={{ height: spacing.sm }} /> : null}
            {incident.manualId ? (
              <Button
                label={`Open linked manual${incident.manualVersion ? ` (v${incident.manualVersion})` : ''}`}
                variant="secondary"
                onPress={() => router.push(`/(app)/manuals/${incident.manualId}`)}
              />
            ) : null}
          </Card>
        ) : null}

        <SectionTitle>Explore</SectionTitle>
        <View style={styles.navGrid}>
          {navButtons.map((button) => (
            <Button key={button.route} label={button.label} variant="secondary" onPress={() => router.push(button.route)} style={styles.navButton} />
          ))}
        </View>

        {canUpdate || attempt('closeIncident') || attempt('reopenIncident') || attempt('cancelIncident') ? (
          <>
            <SectionTitle>Lifecycle</SectionTitle>
            <Card>
              {statusOptions.size > 0 && canUpdate ? (
                <>
                  <Text style={styles.cardHeading}>Change status</Text>
                  <View style={styles.chipWrap}>
                    {[...statusOptions]
                      .filter((next) => next !== 'resolved' && next !== 'cancelled')
                      .map((next) => (
                        <Button
                          key={next}
                          label={incidentStatus(next).label}
                          variant="secondary"
                          onPress={() => setDialog({ kind: 'status', to: next })}
                        />
                      ))}
                  </View>
                  <Text style={styles.hint}>
                    “Resolved” is only reachable by confirming the root cause and the permanent fix.
                  </Text>
                </>
              ) : null}
              {issueOptions.size > 0 && canUpdate ? (
                <>
                  <View style={{ height: spacing.md }} />
                  <Text style={styles.cardHeading}>Issue status</Text>
                  <View style={styles.chipWrap}>
                    {[...issueOptions].map((next) => (
                      <Button
                        key={next}
                        label={issueStatus(next).label}
                        variant="secondary"
                        onPress={() =>
                          setDialog({
                            kind: 'issueStatus',
                            to: next,
                            needsNote: (CONFIRMED_ISSUE_STATUSES as readonly string[]).includes(next),
                          })
                        }
                      />
                    ))}
                  </View>
                </>
              ) : null}
              {incident.status === 'resolved' && attempt('closeIncident') ? (
                <View style={{ marginTop: spacing.md }}>
                  <Button label="Close incident" variant="secondary" onPress={() => setDialog({ kind: 'close' })} />
                </View>
              ) : null}
              {(incident.status === 'resolved' || incident.status === 'closed') && attempt('reopenIncident') ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Button label="Reopen incident" variant="danger" onPress={() => setDialog({ kind: 'reopen' })} />
                </View>
              ) : null}
              {attempt('cancelIncident') && statusOptions.has('cancelled') ? (
                <View style={{ marginTop: spacing.sm }}>
                  <Button label="Cancel incident" variant="danger" onPress={() => setDialog({ kind: 'cancel' })} />
                </View>
              ) : null}
            </Card>
          </>
        ) : null}

        {canUpdate ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Button label="Edit incident" variant="secondary" onPress={() => router.push(`/(app)/incidents/${incident.id}/edit`)} />
          </View>
        ) : null}
      </ScrollView>

      <LifecycleDialog
        dialog={dialog}
        close={() => setDialog(null)}
        incidentId={incident.id}
        userId={userId}
        queued={queued}
        onDone={() => {
          void incidentQuery.refetch();
          void syncNow();
        }}
      />
    </SafeAreaView>
  );
}

function LifecycleDialog({
  dialog,
  close,
  incidentId,
  userId,
  queued,
  onDone,
}: {
  dialog: Dialog;
  close: () => void;
  incidentId: string;
  userId: string;
  queued: ReturnType<typeof useQueuedWrite>;
  onDone: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!dialog) return <View />;

  const title =
    dialog.kind === 'status'
      ? `Change status to “${incidentStatus(dialog.to).label}”?`
      : dialog.kind === 'issueStatus'
        ? `Set issue status to “${issueStatus(dialog.to).label}”?`
        : dialog.kind === 'close'
          ? 'Close this incident?'
          : dialog.kind === 'reopen'
            ? 'Reopen this incident?'
            : 'Cancel this incident?';

  const needsInput =
    dialog.kind === 'close' ||
    dialog.kind === 'reopen' ||
    dialog.kind === 'cancel' ||
    (dialog.kind === 'issueStatus' && dialog.needsNote);

  const inputLabel =
    dialog.kind === 'close'
      ? 'Resolution summary (required)'
      : dialog.kind === 'reopen'
        ? 'Reason (required)'
        : dialog.kind === 'cancel'
          ? 'Reason (required)'
          : 'Note (required for confirmed issue statuses)';

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dialog.kind === 'cancel') {
        // DELETE has delete-and-reason semantics; it is never queued.
        await cancelIncident(incidentId, note);
        Alert.alert('Incident cancelled', 'The incident has been cancelled.');
        close();
        onDone();
        return;
      }
      let result: QueuedWriteResult;
      if (dialog.kind === 'status') {
        result = await queued.mutateAsync({ type: 'change_status', payload: { incidentId, status: dialog.to, reason: note || undefined } });
      } else if (dialog.kind === 'issueStatus') {
        result = await queued.mutateAsync({ type: 'change_issue_status', payload: { incidentId, issueStatus: dialog.to, note: note || undefined } });
      } else if (dialog.kind === 'close') {
        result = await queued.mutateAsync({ type: 'close_incident', payload: { incidentId, resolutionSummary: note } });
      } else {
        result = await queued.mutateAsync({ type: 'reopen_incident', payload: { incidentId, reason: note } });
      }
      if (result.kind === 'queued') {
        Alert.alert('Saved offline', 'The change is saved on this device and will sync when you are connected. The incident is NOT changed yet.');
      } else if (result.kind === 'review') {
        Alert.alert('Needs review', 'The server did not confirm this change (possible conflict). Open Profile → Queued changes to review it.');
      } else if (result.kind === 'failed') {
        setError(result.op.lastError ?? 'The server rejected this change.');
        return;
      }
      close();
      setNote('');
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
      title={title}
      message={
        dialog.kind === 'close'
          ? 'Closing locks the incident. It can only be reopened afterwards.'
          : dialog.kind === 'reopen'
            ? 'Reopening signals the problem returned or the fix did not hold.'
            : 'The change is audited and attributed to you.'
      }
      confirmLabel={dialog.kind === 'cancel' ? 'Cancel incident' : 'Confirm'}
      cancelLabel="Keep as is"
      danger={dialog.kind === 'reopen' || dialog.kind === 'cancel'}
      loading={busy}
      onCancel={close}
      onConfirm={() => void confirm()}
    >
      {needsInput ? (
        <View>
          <Text style={styles.dialogLabel}>{inputLabel}</Text>
          <TextInput
            style={styles.dialogInput}
            multiline
            value={note}
            onChangeText={setNote}
            placeholder="Type here…"
            placeholderTextColor={colors.textSubtle}
          />
        </View>
      ) : null}
      {error ? <InlineBanner tone="error">{error}</InlineBanner> : null}
    </ConfirmDialog>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  title: { color: colors.text, fontSize: typeScale.heading, fontWeight: '800', marginBottom: spacing.md },
  cardHeading: { color: colors.text, fontSize: typeScale.subheading, fontWeight: '700', marginBottom: spacing.xs },
  body: { color: colors.textMuted, fontSize: typeScale.body, lineHeight: 22 },
  hint: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.xs },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  navGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  navButton: { flexGrow: 1, minWidth: '46%' },
  dialogLabel: { color: colors.textMuted, fontSize: typeScale.small, marginBottom: spacing.xs },
  dialogInput: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: 6,
    color: colors.text,
    fontSize: typeScale.body,
    minHeight: 80,
    padding: 10,
    textAlignVertical: 'top',
  },
});
