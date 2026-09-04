/**
 * Profile: session details, capability summary, offline sync management,
 * local cache controls and sign out.
 */
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useSyncStatus } from '@/hooks/queries';
import { useSyncEngine } from '@/hooks/use-sync';
import { useNetwork } from '@/hooks/use-network';
import { capabilitiesOf } from '@/lib/permissions';
import { Badge, Button, Card, Chip, KeyValue, SectionTitle } from '@/components/ui';
import { ConfirmDialog } from '@/components/banners';
import { OutboxOpRow, type OutboxOpView } from '@/components/list-rows';
import { EmptyState } from '@/components/states';
import { reviewOpAfterUserDecision } from '@/db/sync';
import { deleteOp, retryOp } from '@/db/outbox';
import { cacheClear } from '@/db/cache';
import { env } from '@/config/env';
import { formatDateTime, relativeTime } from '@/lib/format';
import { errorMessage } from '@/api/errors';
import { spacing, type as typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/theme-context';

export default function ProfileScreen(): React.JSX.Element {
  const { user, logout } = useAuth();
  const { colors, isDark, toggleTheme } = useTheme();
  const { isOnline } = useNetwork();
  const userId = user?.id ?? '';
  // The profile IS the sync status screen: keep the counts live while here.
  const sync = useSyncStatus(userId, true);
  const { syncNow } = useSyncEngine(userId);
  const [signOutVisible, setSignOutVisible] = useState(false);
  const [clearCacheVisible, setClearCacheVisible] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const initials = (user?.fullName ?? user?.username ?? 'U')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  const onRetryOp = (op: OutboxOpView) => {
    retryOp(op.id);
    void sync.refetch();
    void syncNow();
  };
  const onDiscardOp = (op: OutboxOpView) => {
    deleteOp(op.id);
    void sync.refetch();
  };
  const onReviewOp = (op: OutboxOpView) => {
    Alert.alert(
      'Review this change',
      `${op.lastError ?? 'The server could not confirm this change.'}\n\nCheck the incident in the app first. If the change is still correct, press Retry; otherwise discard it.`,
      [
        { text: 'Discard', style: 'destructive', onPress: () => onDiscardOp(op) },
        { text: 'Retry now', onPress: () => onRetryOp(op) },
        { text: 'Keep for later', style: 'cancel' },
      ],
    );
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.bg }]} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Profile',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.profileHero, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.avatar, { backgroundColor: colors.primaryBg, borderColor: colors.primary }]}>
            <Text style={[styles.avatarText, { color: colors.primary }]}>{initials || 'U'}</Text>
          </View>
          <View style={styles.heroText}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{user?.fullName ?? 'User'}</Text>
            <Text style={[styles.username, { color: colors.textMuted }]} numberOfLines={1}>@{user?.username ?? 'account'}</Text>
            <View style={styles.heroBadges}>
              <Badge icon="●" label={isOnline ? 'Online' : 'Offline'} tone={isOnline ? 'ok' : 'warn'} size="sm" />
              <Badge icon="◆" label={user?.role ?? 'Role'} tone="info" size="sm" />
            </View>
          </View>
        </View>

        <SectionTitle>Appearance</SectionTitle>
        <Card>
          <View style={styles.appearanceRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Theme</Text>
              <Text style={[styles.body, { color: colors.textMuted }]}>Switch between a bright workspace and the low-light field view.</Text>
            </View>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: isDark }}
              accessibilityLabel="Toggle dark mode"
              onPress={toggleTheme}
              style={[styles.themeToggle, { backgroundColor: colors.surfaceRaised, borderColor: colors.borderStrong }]}
            >
              <View style={[styles.togglePill, !isDark && { backgroundColor: colors.primary }]}>
                <Text style={[styles.toggleText, { color: !isDark ? colors.onPrimary : colors.textMuted }]}>Light</Text>
              </View>
              <View style={[styles.togglePill, isDark && { backgroundColor: colors.primary }]}>
                <Text style={[styles.toggleText, { color: isDark ? '#ffffff' : colors.textMuted }]}>Dark</Text>
              </View>
            </Pressable>
          </View>
        </Card>

        <SectionTitle>Account</SectionTitle>
        <Card>
          <KeyValue label="Name" value={user?.fullName ?? '—'} />
          <KeyValue label="Username" value={user?.username ?? '—'} />
          <KeyValue label="Email" value={user?.email ?? '—'} />
          <KeyValue label="Role" value={user?.role ?? '—'} />
          <KeyValue label="Last sign-in" value={formatDateTime(user?.lastLoginAt)} />
          {user?.mustChangePassword ? (
            <Text style={[styles.warning, { color: colors.warn }]}>
              You must change your password (web app or administrator). This banner stays until then.
            </Text>
          ) : null}
        </Card>

        <SectionTitle>Permissions</SectionTitle>
        <Card>
          <Text style={[styles.body, { color: colors.textMuted }]}>Effective capabilities for role “{user?.role}” (the server enforces these):</Text>
          <View style={styles.capabilityWrap}>
            {capabilitiesOf(user?.role)
              .slice(0, 24)
              .map((capability) => (
                <Chip key={capability} label={capability} />
              ))}
          </View>
        </Card>

        <SectionTitle>Offline sync</SectionTitle>
        <Card>
          <View style={styles.syncSummary}>
            <View style={[styles.syncTile, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
              <Text style={[styles.syncNumber, { color: colors.warn }]}>{sync.data?.pending ?? 0}</Text>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Pending</Text>
            </View>
            <View style={[styles.syncTile, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
              <Text style={[styles.syncNumber, { color: colors.error }]}>{sync.data?.failed ?? 0}</Text>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Failed</Text>
            </View>
            <View style={[styles.syncTile, { backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
              <Text style={[styles.syncNumber, { color: colors.info }]}>{sync.data?.review ?? 0}</Text>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Review</Text>
            </View>
          </View>
          <KeyValue label="Connection" value={isOnline ? 'Online' : 'Offline'} />
          <KeyValue label="Last completed sync" value={relativeTime(sync.data?.lastSyncAt)} />
          <Button
            label="Sync now"
            variant="secondary"
            disabled={!isOnline}
            loading={false}
            onPress={() => void syncNow()}
            testID="profile-sync-now"
          />
        </Card>

        {(sync.data?.ops.length ?? 0) > 0 ? (
          <>
            <SectionTitle>Queued changes</SectionTitle>
            {sync.data?.ops.map((op) => (
              <OutboxOpRow
                key={op.id}
                op={op}
                onRetry={op.status === 'failed' || op.status === 'pending' ? () => onRetryOp(op) : undefined}
                onReview={op.status === 'requires_review' ? () => onReviewOp(op) : undefined}
                onDiscard={op.status !== 'completed' ? () => onDiscardOp(op) : undefined}
              />
            ))}
          </>
        ) : (
          <EmptyState title="No queued changes" message="Actions you take offline appear here until they sync." />
        )}

        <SectionTitle>Local storage</SectionTitle>
        <Card>
          <Text style={[styles.body, { color: colors.textMuted }]}>
            This device caches recently viewed machines, incidents and conversations (short expiry,
            tied to your account) so you can keep working without signal. Tokens live in the device
            keystore, never in this cache.
          </Text>
          <View style={{ height: spacing.md }} />
          <Button label="Clear cached copies" variant="secondary" onPress={() => setClearCacheVisible(true)} />
        </Card>

        <SectionTitle>About</SectionTitle>
        <Card>
          <KeyValue label="App" value="ITP Field 0.1.0" />
          <KeyValue label="API" value={env.apiBaseUrlConfigured} />
          <KeyValue label="Runtime" value="Expo Go (managed workflow)" />
        </Card>

        <Button
          label="Sign out"
          variant="danger"
          size="lg"
          onPress={() => setSignOutVisible(true)}
          testID="profile-signout"
        />
        <View style={{ height: spacing.xl }} />
      </ScrollView>

      <ConfirmDialog
        visible={signOutVisible}
        title="Sign out?"
        message="Queued offline changes stay on this device only until you sign back in on this account. Tokens and cached copies are removed."
        confirmLabel="Sign out"
        danger
        loading={signingOut}
        onCancel={() => setSignOutVisible(false)}
        onConfirm={async () => {
          setSigningOut(true);
          try {
            await logout();
          } catch (error) {
            Alert.alert('Sign out failed', errorMessage(error));
          } finally {
            setSigningOut(false);
            setSignOutVisible(false);
          }
        }}
      />
      <ConfirmDialog
        visible={clearCacheVisible}
        title="Clear cached copies?"
        message="Removes cached machines, incidents and conversations from this device. Queued offline changes are kept."
        confirmLabel="Clear cache"
        danger
        onCancel={() => setClearCacheVisible(false)}
        onConfirm={() => {
          if (userId) cacheClear(userId);
          setClearCacheVisible(false);
          void sync.refetch();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  profileHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  avatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 24, fontWeight: '800' },
  heroText: { flex: 1 },
  name: { fontSize: typeScale.title, fontWeight: '800' },
  username: { fontSize: typeScale.small, marginTop: 2 },
  heroBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  appearanceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardTitle: { fontSize: typeScale.subheading, fontWeight: '700', marginBottom: 4 },
  themeToggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 999,
    padding: 3,
    minHeight: 44,
  },
  togglePill: {
    minWidth: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    paddingHorizontal: 10,
  },
  toggleText: { fontSize: typeScale.tiny, fontWeight: '800' },
  body: { fontSize: typeScale.small, lineHeight: 20 },
  warning: { fontSize: typeScale.small, marginTop: spacing.sm },
  capabilityWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  syncSummary: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  syncTile: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  syncNumber: { fontSize: 22, fontWeight: '800' },
  syncLabel: { fontSize: typeScale.tiny, fontWeight: '700', marginTop: 2 },
});
