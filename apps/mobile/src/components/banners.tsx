/**
 * Offline / sync banners and the confirmation dialog.
 *
 * Destructive or important actions (status changes, closing, reopening,
 * confirmations, cancels) ALWAYS go through ConfirmDialog with an explicit,
 * unambiguous confirm button.
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from './ui';
import { radius, spacing, type as typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/theme-context';

export function OfflineBanner({ visible }: { visible: boolean }): React.JSX.Element | null {
  const { colors } = useTheme();
  if (!visible) return null;
  return (
    <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.warn }]} accessibilityLabel="You are offline">
      <Text style={[styles.icon, { color: colors.warn }]} aria-hidden>
        ⊘
      </Text>
      <Text style={[styles.text, { color: colors.warn }]}>
        Offline — changes are saved on this device and synced when reconnected.
      </Text>
    </View>
  );
}

export function PendingSyncBanner({
  pending,
  review,
  onPress,
}: {
  pending: number;
  review: number;
  onPress: () => void;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  if (pending <= 0 && review <= 0) return null;
  const tone = review > 0 ? colors.error : colors.info;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pending} pending changes. Open sync status.`}
      onPress={onPress}
      style={[styles.banner, { backgroundColor: colors.surface, borderColor: tone }]}
    >
      <Text style={[styles.icon, { color: tone }]} aria-hidden>
        ↻
      </Text>
      <Text style={[styles.text, { color: tone }]}>
        {review > 0
          ? `${review} change${review === 1 ? '' : 's'} need${review === 1 ? 's' : ''} review · ${pending} pending`
          : `${pending} change${pending === 1 ? '' : 's'} waiting to sync`}
      </Text>
    </Pressable>
  );
}

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  testID?: string;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
  children,
  testID,
}: ConfirmDialogProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.dialog, { backgroundColor: colors.surfaceRaised, borderColor: colors.borderStrong }]} accessibilityViewIsModal testID={testID}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          {message ? <Text style={[styles.message, { color: colors.textMuted }]}>{message}</Text> : null}
          {children}
          <View style={styles.actions}>
            <Button label={cancelLabel} variant="secondary" onPress={onCancel} disabled={loading} style={styles.action} />
            <Button
              label={confirmLabel}
              variant={danger ? 'danger' : 'primary'}
              onPress={onConfirm}
              loading={loading}
              style={styles.action}
              testID={testID ? `${testID}-confirm` : undefined}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  icon: { fontSize: 18 },
  text: { flex: 1, fontSize: typeScale.small },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 480,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  title: { fontSize: typeScale.heading, fontWeight: '700', marginBottom: spacing.sm },
  message: { fontSize: typeScale.body, marginBottom: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  action: { flex: 1 },
});
