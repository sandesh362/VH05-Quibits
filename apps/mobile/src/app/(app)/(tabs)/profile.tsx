/**
 * Profile: session details, capability summary, offline sync management,
 * local cache controls and sign out.
 */
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { useSyncStatus } from '@/hooks/queries';
import { useSyncEngine } from '@/hooks/use-sync';
import { useNetwork } from '@/hooks/use-network';
import { capabilitiesOf } from '@/lib/permissions';
import { Button, Card, Chip, KeyValue, SectionTitle } from '@/components/ui';
import { ConfirmDialog } from '@/components/banners';
import { OutboxOpRow, type OutboxOpView } from '@/components/list-rows';
import { EmptyState } from '@/components/states';
import { reviewOpAfterUserDecision } from '@/db/sync';
import { deleteOp, retryOp } from '@/db/outbox';
import { cacheClear } from '@/db/cache';
import { env } from '@/config/env';
import { formatDateTime, relativeTime } from '@/lib/format';
import { errorMessage } from '@/api/errors';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

export default function ProfileScreen(): React.JSX.Element {
  const { user, logout } = useAuth();
  const { isOnline } = useNetwork();
  const userId = user?.id ?? '';
  // The profile IS the sync status screen: keep the counts live while here.
  const sync = useSyncStatus(userId, true);
  const { syncNow } = useSyncEngine(userId);
  const [signOutVisible, setSignOutVisible] = useState(false);
  const [clearCacheVisible, setClearCacheVisible] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
    <SafeAreaView style={styles.screen} edges={['bottom']}>
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
        <SectionTitle>Account</SectionTitle>
        <Card>
          <KeyValue label="Name" value={user?.fullName ?? '—'} />
          <KeyValue label="Username" value={user?.username ?? '—'} />
          <KeyValue label="Email" value={user?.email ?? '—'} />
          <KeyValue label="Role" value={user?.role ?? '—'} />
          <KeyValue label="Last sign-in" value={formatDateTime(user?.lastLoginAt)} />
          {user?.mustChangePassword ? (
            <Text style={styles.warning}>
              You must change your password (web app or administrator). This banner stays until then.
            </Text>
          ) : null}
        </Card>

        <SectionTitle>Permissions</SectionTitle>
        <Card>
          <Text style={styles.body}>Effective capabilities for role “{user?.role}” (the server enforces these):</Text>
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
          <KeyValue label="Connection" value={isOnline ? 'Online' : 'Offline'} />
          <KeyValue label="Last completed sync" value={relativeTime(sync.data?.lastSyncAt)} />
          <KeyValue label="Pending" value={String(sync.data?.pending ?? 0)} />
          <KeyValue label="Failed" value={String(sync.data?.failed ?? 0)} />
          <KeyValue label="Needs review" value={String(sync.data?.review ?? 0)} />
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
          <Text style={styles.body}>
            This device caches recently viewed machines, incidents and conversations (short expiry,
            tied to your account) so you can keep working without signal. Tokens live in the device
            keystore, never in this cache.
          </Text>
          <View style={{ height: spacing.sm }} />
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
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  body: { color: colors.textMuted, fontSize: typeScale.small, lineHeight: 20 },
  warning: { color: colors.warn, fontSize: typeScale.small, marginTop: spacing.sm },
  capabilityWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
});
