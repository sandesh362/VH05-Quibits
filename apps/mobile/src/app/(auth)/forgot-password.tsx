/**
 * Password reset is NOT available on mobile: the backend has no
 * forgot-password endpoint (only authenticated change-password). This screen
 * says exactly that instead of pretending otherwise.
 */
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Button } from '@/components/ui';
import { InlineBanner } from '@/components/states';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

export default function ForgotPassword(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Reset your password</Text>
        <InlineBanner tone="warn">
          Password reset is not available in the field app. Ask your manager or
          administrator to reset it for you; then sign in here with the new password.
        </InlineBanner>
        <Card>
          <Text style={styles.body}>
            Once signed in you can change your own password from the Profile tab
            (requires your current password). The web app offers the same flow.
          </Text>
        </Card>
        <Button label="Back to sign in" onPress={() => router.back()} />
        <Pressable accessibilityRole="button" onPress={() => router.replace('/(auth)/login')}>
          <Text style={styles.link}>Sign in</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  title: { color: colors.text, fontSize: typeScale.title, fontWeight: '700' },
  body: { color: colors.textMuted, fontSize: typeScale.body, lineHeight: 22 },
  link: { color: colors.primary, fontSize: typeScale.subheading, textAlign: 'center', paddingVertical: spacing.sm },
});
