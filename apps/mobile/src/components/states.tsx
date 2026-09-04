/**
 * Loading, empty, error and offline-copy states.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from './ui';
import { colors, radius, spacing, type as typeScale } from '@/theme/tokens';

export function LoadingState({ label = 'Loading…' }: { label?: string }): React.JSX.Element {
  return (
    <View style={styles.container} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

/** Skeleton list placeholder shown instead of spinners on list screens. */
export function SkeletonList({ rows = 4 }: { rows?: number }): React.JSX.Element {
  return (
    <View accessibilityLabel="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <View style={styles.skeletonLine} />
          <View style={[styles.skeletonLine, styles.skeletonLineShort]} />
        </View>
      ))}
    </View>
  );
}

export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
  testID,
}: {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.container} testID={testID} accessibilityLabel={title}>
      <Text style={styles.icon} aria-hidden>
        ○
      </Text>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.text}>{message}</Text> : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="secondary" style={styles.action} />
      ) : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
  requestId,
  testID,
}: {
  message: string;
  onRetry?: () => void;
  requestId?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.container} testID={testID} accessibilityLabel={`Error: ${message}`}>
      <Text style={styles.icon} aria-hidden>
        ⚠
      </Text>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.text}>{message}</Text>
      {requestId ? <Text style={styles.requestId}>Reference: {requestId}</Text> : null}
      {onRetry ? <Button label="Try again" onPress={onRetry} variant="secondary" style={styles.action} /> : null}
    </View>
  );
}

/** Slim notice shown when a screen renders cached data while offline. */
export function CachedNotice({ age }: { age: string }): React.JSX.Element {
  return (
    <View style={styles.cached} accessibilityLabel="Showing a saved copy">
      <Text style={styles.cachedText}>Offline — showing a saved copy ({age}). Data may be out of date.</Text>
    </View>
  );
}

export function InlineBanner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  children: React.ReactNode;
}): React.JSX.Element {
  const color =
    tone === 'error' ? colors.error : tone === 'warn' ? colors.warn : tone === 'ok' ? colors.ok : colors.info;
  return (
    <View style={[styles.banner, { borderColor: color }]}>
      <Text style={[styles.bannerText, { color }]}>{children}</Text>
    </View>
  );
}

export function PressableRow({
  onPress,
  children,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
  children: React.ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  icon: { fontSize: 40, color: colors.textSubtle, marginBottom: spacing.sm },
  title: { color: colors.text, fontSize: typeScale.subheading, fontWeight: '700', marginBottom: spacing.xs, textAlign: 'center' },
  text: { color: colors.textMuted, fontSize: typeScale.small, textAlign: 'center' },
  requestId: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.xs },
  action: { marginTop: spacing.md, minWidth: 160 },
  skeletonRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  skeletonLine: {
    backgroundColor: colors.surfaceRaised,
    height: 14,
    borderRadius: 4,
    marginBottom: 8,
  },
  skeletonLineShort: { width: '55%' },
  cached: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warn,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  cachedText: { color: colors.warn, fontSize: typeScale.small },
  banner: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  bannerText: { fontSize: typeScale.small },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 64,
  },
});
