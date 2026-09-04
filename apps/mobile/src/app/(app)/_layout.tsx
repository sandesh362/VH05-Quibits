/**
 * Protected area layout.
 *
 * The root AuthGate already redirects unauthenticated users; this layout adds
 * the offline banner, the pending-sync banner and the per-screen stack.
 */
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useNetwork } from '@/hooks/use-network';
import { useSyncStatus } from '@/hooks/queries';
import { OfflineBanner, PendingSyncBanner } from '@/components/banners';
import { initDatabase } from '@/db/database';
import { colors } from '@/theme/tokens';

export default function ProtectedLayout(): React.JSX.Element {
  const { user } = useAuth();
  const { isOnline } = useNetwork();
  const [visible, setVisible] = useState(true);
  const sync = useSyncStatus(user?.id ?? '', false);

  useFocusEffect(
    useCallback(() => {
      if (user) {
        initDatabase();
        sync.refetch();
      }
      setVisible(true);
      return () => setVisible(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id]),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      {visible ? (
        <View>
          <OfflineBanner visible={!isOnline} />
          <PendingSyncBanner
            pending={sync.data?.pending ?? 0}
            review={sync.data?.review ?? 0}
            onPress={() => router.push('/(app)/(tabs)/profile')}
          />
        </View>
      ) : null}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </SafeAreaView>
  );
}
