/**
 * List row components: incident, machine, conversation, manual, action,
 * timeline event, outbox operation.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  IncidentActionView,
  IncidentTimelineEventView,
  IncidentView,
  MessageView,
} from '@itp/shared';
import type { ConversationListItem, MachineView, ManualView } from '@/api/types';
import { Badge } from './ui';
import {
  actionResultStatus,
  actionSourceType,
  conversationStatus,
  fixStatus,
  incidentStatus,
  issueStatus,
  machineStatus,
  outboxOpLabel,
  processingStatus,
  rootCauseStatus,
  severity as severityPresentation,
  syncOpStatus,
} from '@/lib/labels';
import { formatBytes, formatDateTime, relativeTime } from '@/lib/format';
import { colors, radius, spacing, type as typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/theme-context';

export interface RowAction {
  onPress: () => void;
  accessibilityLabel?: string;
}

export function IncidentRow({ incident, onPress }: { incident: IncidentView; onPress: () => void }): React.JSX.Element {
  const theme = useTheme();
  const sev = severityPresentation(incident.severity);
  const status = incidentStatus(incident.status);
  const issue = issueStatus(incident.issueStatus);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${incident.incidentNumber}. ${incident.title}. Severity ${sev.label}. Status ${status.label}.`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={styles.rowHeader}>
        <Text style={[styles.rowNumber, { color: theme.colors.textSubtle }]} numberOfLines={1}>
          {incident.incidentNumber}
        </Text>
        <Badge {...sev} size="sm" />
      </View>
      <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={2}>
        {incident.title}
      </Text>
      <Text style={[styles.rowSub, { color: theme.colors.textMuted }]} numberOfLines={1}>
        {incident.machineLabel ?? incident.machineModelLabel ?? 'No machine link'}
      </Text>
      <View style={styles.badgeRow}>
        <Badge {...status} size="sm" />
        <Badge {...issue} size="sm" />
        <Text style={[styles.rowTime, { color: theme.colors.textSubtle }]}>{relativeTime(incident.updatedAt)}</Text>
      </View>
    </Pressable>
  );
}

export function MachineRow({ machine, onPress }: { machine: MachineView; onPress: () => void }): React.JSX.Element {
  const status = machineStatus(machine.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Machine ${machine.displayName ?? machine.assetTag}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.rowHeader}>
        <Text style={[styles.rowTitle, { flexShrink: 1 }]} numberOfLines={1}>
          {machine.displayName ?? machine.assetTag}
        </Text>
        <Badge {...status} size="sm" />
      </View>
      <Text style={styles.rowSub} numberOfLines={1}>
        {machine.assetTag}
        {machine.serialNumber ? ` · SN ${machine.serialNumber}` : ''}
      </Text>
      <Text style={styles.rowSub} numberOfLines={1}>
        {machine.modelSnapshot ? `${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName}` : ''}
      </Text>
      {machine.openIncidentCount > 0 ? (
        <Text style={[styles.rowTime, { color: colors.warn }]}>
          {machine.openIncidentCount} open incident{machine.openIncidentCount === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function ConversationRow({ conversation, onPress }: { conversation: ConversationListItem; onPress: () => void }): React.JSX.Element {
  const status = conversationStatus(conversation.status);
  const issue = issueStatus(conversation.issueStatus);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Conversation ${conversation.title ?? conversation.machineLabel ?? ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.rowHeader}>
        <Text style={[styles.rowTitle, { flexShrink: 1 }]} numberOfLines={1}>
          {conversation.title || conversation.machineLabel || conversation.machineModelLabel || 'Conversation'}
        </Text>
        <Badge {...status} size="sm" />
      </View>
      <View style={styles.badgeRow}>
        <Badge {...issue} size="sm" />
        <Text style={styles.rowTime}>
          {conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}
        </Text>
        <Text style={styles.rowTime}>{relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}</Text>
      </View>
    </Pressable>
  );
}

export function ManualRow({ manual, onPress }: { manual: ManualView; onPress: () => void }): React.JSX.Element {
  const processing = processingStatus(manual.processingStatus);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Manual ${manual.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.rowHeader}>
        <Text style={[styles.rowTitle, { flexShrink: 1 }]} numberOfLines={2}>
          {manual.title}
        </Text>
        <Badge {...processing} size="sm" />
      </View>
      <Text style={styles.rowSub} numberOfLines={1}>
        {manual.documentVersion ? `Version ${manual.documentVersion} · ` : ''}
        {manual.documentType.replace(/_/g, ' ')}
        {manual.isCurrentVersion ? '' : ' · superseded'}
      </Text>
      <Text style={styles.rowSub} numberOfLines={1}>
        {formatBytes(manual.fileSizeBytes)}
        {manual.pageCount ? ` · ${manual.pageCount} pages` : ''}
        {manual.scope === 'machine' ? ' · this machine' : ' · model-wide'}
      </Text>
    </Pressable>
  );
}

export function IncidentActionRow({
  action,
  onConfirm,
}: {
  action: IncidentActionView;
  onConfirm?: () => void;
}): React.JSX.Element {
  const source = actionSourceType(action.actionType);
  const result = actionResultStatus(action.resultStatus);
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Badge {...source} size="sm" />
        <Badge {...result} size="sm" />
        {action.confirmed ? (
          <Badge icon="✓" label="Confirmed" tone="ok" size="sm" />
        ) : (
          <Badge icon="○" label="Unconfirmed" tone="warn" size="sm" />
        )}
      </View>
      <Text style={styles.rowTitle}>{action.description}</Text>
      {action.result ? <Text style={styles.rowSub}>Result: {action.result}</Text> : null}
      <Text style={styles.rowSub}>
        {formatDateTime(action.performedAt)}
        {action.performedByName ? ` · by ${action.performedByName}` : ''}
      </Text>
      {onConfirm && !action.confirmed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Confirm this action result"
          onPress={onConfirm}
          style={styles.inlineButton}
        >
          <Text style={styles.inlineButtonText}>Confirm result</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const TIMELINE_PRESENTATION: Record<string, { icon: string; label: string }> = {
  incident_created: { icon: '★', label: 'Incident created' },
  incident_updated: { icon: '✎', label: 'Incident updated' },
  assignment_changed: { icon: '👤', label: 'Assignment changed' },
  status_changed: { icon: '↺', label: 'Status changed' },
  issue_status_changed: { icon: '⚑', label: 'Issue status changed' },
  root_cause_changed: { icon: '∼', label: 'Root cause updated' },
  root_cause_confirmed: { icon: '✓', label: 'Root cause confirmed' },
  root_cause_rejected: { icon: '✕', label: 'Root cause rejected' },
  incident_closed: { icon: '■', label: 'Incident closed' },
  incident_reopened: { icon: '↻', label: 'Incident reopened' },
  incident_cancelled: { icon: '✕', label: 'Incident cancelled' },
  similar_incident_search: { icon: '⌕', label: 'Similar-incident search' },
  qdrant_reindex_queued: { icon: '⟳', label: 'Re-index queued' },
  action_recorded: { icon: '🔧', label: 'Technician action' },
  fix_recorded: { icon: '◉', label: 'Fix recorded' },
  fix_confirmed: { icon: '✓', label: 'Fix confirmed' },
};

export function TimelineEventRow({ event }: { event: IncidentTimelineEventView }): React.JSX.Element {
  const presentation = TIMELINE_PRESENTATION[event.type] ?? { icon: '·', label: event.type.replace(/_/g, ' ') };
  const detail =
    event.next && typeof event.next === 'object'
      ? Object.entries(event.next as Record<string, unknown>)
          .slice(0, 3)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join(' · ')
      : '';
  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineRail}>
        <Text style={styles.timelineIcon} aria-hidden>
          {presentation.icon}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{presentation.label}</Text>
        {detail ? <Text style={styles.rowSub} numberOfLines={2}>{detail}</Text> : null}
        {event.note ? <Text style={styles.rowSub}>Note: {event.note}</Text> : null}
        <Text style={styles.rowTime}>
          {formatDateTime(event.at)}
          {event.actorUsername ? ` · ${event.actorUsername}` : ''}
        </Text>
      </View>
    </View>
  );
}

/** Message bubble for the assistant thread. */
export function MessageBubble({ message }: { message: MessageView }): React.JSX.Element {
  const isUser = message.role === 'user';
  const failed = message.status === 'failed';
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : failed ? styles.bubbleFailed : styles.bubbleAssistant]}>
      <Text style={styles.bubbleRole}>{isUser ? 'You' : 'Assistant'}</Text>
      <Text selectable style={styles.bubbleContent}>
        {message.content}
      </Text>
      {message.clarification ? <Text style={styles.bubbleWarn}>? {message.clarification}</Text> : null}
      {message.refusalReason ? <Text style={styles.bubbleError}>⚠ {message.refusalReason}</Text> : null}
      {message.suggestedActions.length > 0 ? (
        <View style={styles.suggestions}>
          <Text style={styles.suggestionsTitle}>Suggested checks (NOT performed):</Text>
          {message.suggestedActions.map((suggestion) => (
            <Text key={suggestion.id} style={styles.suggestionsItem}>
              • {suggestion.description}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.bubbleTime}>{formatDateTime(message.createdAt)}</Text>
    </View>
  );
}

export function OutboxOpRow({
  op,
  onRetry,
  onDiscard,
  onReview,
}: {
  op: OutboxOpView;
  onRetry?: () => void;
  onDiscard?: () => void;
  onReview?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const presentation = syncOpStatus(op.status);
  return (
    <View style={[styles.row, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      <View style={styles.rowHeader}>
        <Text style={[styles.rowTitle, { color: theme.colors.text, flexShrink: 1 }]} numberOfLines={1}>
          {outboxOpLabel[op.type] ?? op.type}
        </Text>
        <Badge {...presentation} size="sm" />
      </View>
      <Text style={[styles.rowSub, { color: theme.colors.textMuted }]}>{formatDateTime(op.createdAt)}</Text>
      {op.lastError ? <Text style={[styles.rowSub, { color: theme.colors.error }]}>{op.lastError}</Text> : null}
      <View style={styles.badgeRow}>
        {onRetry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} style={[styles.inlineButton, { borderColor: theme.colors.primary }]}>
            <Text style={[styles.inlineButtonText, { color: theme.colors.primary }]}>Retry</Text>
          </Pressable>
        ) : null}
        {onReview ? (
          <Pressable accessibilityRole="button" onPress={onReview} style={[styles.inlineButton, { borderColor: theme.colors.primary }]}>
            <Text style={[styles.inlineButtonText, { color: theme.colors.primary }]}>Review</Text>
          </Pressable>
        ) : null}
        {onDiscard ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard this queued change"
            onPress={onDiscard}
            style={[styles.inlineButton, { borderColor: theme.colors.error }]}
          >
            <Text style={[styles.inlineButtonText, { color: theme.colors.error }]}>Discard</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export interface OutboxOpView {
  id: string;
  type: string;
  status: 'pending' | 'syncing' | 'completed' | 'failed' | 'requires_review';
  createdAt: string;
  lastError: string | null;
}

// Fix presentation row (temp/permanent).
export function FixCard({
  kind,
  fix,
  onRecord,
  onConfirm,
  canRecord,
  canConfirm,
}: {
  kind: 'Temporary fix' | 'Permanent fix';
  fix: { description: string; result: string | null; status: 'recorded' | 'confirmed' | 'rejected'; confirmedAt: string | null; notes: string | null; recordedAt: string } | null;
  onRecord: () => void;
  onConfirm: () => void;
  canRecord: boolean;
  canConfirm: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle}>{kind}</Text>
        {fix ? <Badge {...fixStatus(fix.status)} size="sm" /> : <Badge icon="—" label="None recorded" tone="neutral" size="sm" />}
      </View>
      {fix ? (
        <>
          <Text style={styles.rowSub}>{fix.description}</Text>
          {fix.result ? <Text style={styles.rowSub}>Result: {fix.result}</Text> : null}
          <Text style={styles.rowTime}>
            Recorded {formatDateTime(fix.recordedAt)}
            {fix.confirmedAt ? ` · confirmed ${formatDateTime(fix.confirmedAt)}` : ' · awaiting confirmation'}
          </Text>
          {fix.status === 'recorded' && canConfirm ? (
            <Pressable accessibilityRole="button" onPress={onConfirm} style={styles.inlineButton}>
              <Text style={styles.inlineButtonText}>Confirm this {kind.toLowerCase()}</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.rowSub}>No {kind.toLowerCase()} has been recorded.</Text>
          {canRecord ? (
            <Pressable accessibilityRole="button" onPress={onRecord} style={styles.inlineButton}>
              <Text style={styles.inlineButtonText}>Record {kind.toLowerCase()}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

export function RootCauseCard({
  rootCause,
  canUpdate,
  onUpdate,
  onConfirm,
  onReject,
}: {
  rootCause: { text: string | null; status: 'unknown' | 'suspected' | 'confirmed' | 'rejected'; confirmationNote: string | null; confirmedAt: string | null; rejectionReason: string | null };
  canUpdate: boolean;
  onUpdate: () => void;
  onConfirm: () => void;
  onReject: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowTitle}>Root cause</Text>
        <Badge {...rootCauseStatus(rootCause.status)} size="sm" />
      </View>
      {rootCause.text ? <Text style={styles.rowSub}>{rootCause.text}</Text> : <Text style={styles.rowSub}>Not recorded yet.</Text>}
      {rootCause.confirmationNote ? <Text style={styles.rowTime}>Confirmation: {rootCause.confirmationNote}</Text> : null}
      {rootCause.confirmedAt ? <Text style={styles.rowTime}>Confirmed {formatDateTime(rootCause.confirmedAt)}</Text> : null}
      {rootCause.rejectionReason ? <Text style={styles.rowTime}>Rejected: {rootCause.rejectionReason}</Text> : null}
      <View style={styles.badgeRow}>
        {canUpdate && (rootCause.status === 'unknown' || rootCause.status === 'suspected') ? (
          <Pressable accessibilityRole="button" onPress={onUpdate} style={styles.inlineButton}>
            <Text style={styles.inlineButtonText}>Set suspected cause</Text>
          </Pressable>
        ) : null}
        {canUpdate && rootCause.status === 'suspected' ? (
          <Pressable accessibilityRole="button" onPress={onConfirm} style={styles.inlineButton}>
            <Text style={styles.inlineButtonText}>Confirm</Text>
          </Pressable>
        ) : null}
        {canUpdate && (rootCause.status === 'suspected' || rootCause.status === 'confirmed') ? (
          <Pressable accessibilityRole="button" onPress={onReject} style={[styles.inlineButton, { borderColor: colors.error }]}>
            <Text style={[styles.inlineButtonText, { color: colors.error }]}>Reject</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs, flexWrap: 'wrap' },
  rowNumber: { color: colors.textSubtle, fontSize: typeScale.tiny, fontWeight: '700', flexShrink: 1 },
  rowTitle: { color: colors.text, fontSize: typeScale.body, fontWeight: '600' },
  rowSub: { color: colors.textMuted, fontSize: typeScale.small, marginTop: 2 },
  rowTime: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.xs },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  inlineButton: {
    borderColor: colors.primary,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  inlineButtonText: { color: colors.primary, fontSize: typeScale.small, fontWeight: '600' },
  timelineRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  timelineRail: { alignItems: 'center', width: 28 },
  timelineIcon: { fontSize: 16, color: colors.primary },
  bubble: {
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    maxWidth: '92%',
  },
  bubbleUser: { backgroundColor: colors.primaryBg, alignSelf: 'flex-end', borderColor: colors.primary, borderWidth: 1 },
  bubbleAssistant: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, alignSelf: 'flex-start' },
  bubbleFailed: { backgroundColor: colors.errorBg, borderColor: colors.error, borderWidth: 1, alignSelf: 'flex-start' },
  bubbleRole: { color: colors.textSubtle, fontSize: typeScale.tiny, fontWeight: '700', marginBottom: 4 },
  bubbleContent: { color: colors.text, fontSize: typeScale.small, lineHeight: 21 },
  bubbleWarn: { color: colors.warn, fontSize: typeScale.small, marginTop: spacing.sm },
  bubbleError: { color: colors.error, fontSize: typeScale.small, marginTop: spacing.sm },
  bubbleTime: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.sm },
  suggestions: { marginTop: spacing.sm, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.sm },
  suggestionsTitle: { color: colors.warn, fontSize: typeScale.tiny, fontWeight: '700', marginBottom: 4 },
  suggestionsItem: { color: colors.textMuted, fontSize: typeScale.tiny },
});
