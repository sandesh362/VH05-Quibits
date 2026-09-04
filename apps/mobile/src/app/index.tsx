/**
 * Entry route: decide where the user lands based on session state.
 */
import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '@/auth/auth-context';
import { colors } from '@/theme/tokens';

export default function Index(): React.JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  if (status === 'authenticated') return <Redirect href="/(app)/(tabs)/home" />;
  return <Redirect href="/(auth)/login" />;
}
