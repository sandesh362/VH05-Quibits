import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '@/components/ui';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

export default function NotFound(): React.JSX.Element {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Page not found</Text>
      <Text style={styles.text}>This screen does not exist, or you no longer have access to it.</Text>
      <Button label="Go to Home" onPress={() => router.replace('/(app)/(tabs)/home')} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: '700' },
  text: { color: colors.textMuted, textAlign: 'center' },
});
