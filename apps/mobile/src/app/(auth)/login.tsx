/**
 * Login.
 *
 * Errors are deliberate and generic: invalid credentials and unknown accounts
 * return the same message (matching the backend's anti-enumeration policy).
 * Disabled accounts (403) and lockouts (429) get their own copy.
 */
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { loginSchema, type LoginValues } from '@/validation/schemas';
import { ApiError, errorMessage } from '@/api/errors';
import { Button, TextField } from '@/components/ui';
import { InlineBanner } from '@/components/states';
import { isLoopbackBaseUrl } from '@/config/env';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

export default function Login(): React.JSX.Element {
  const { login, expired, clearExpired } = useAuth();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    clearExpired();
    try {
      await login(values.email.trim(), values.password);
      router.replace('/(app)/(tabs)/home');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        setFormError('Too many sign-in attempts. This account is temporarily locked — try again later.');
      } else if (error instanceof ApiError && error.status === 403) {
        setFormError('This account is disabled. Contact your administrator.');
      } else {
        setFormError(errorMessage(error));
      }
    }
  });

  const loopbackWarning = isLoopbackBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL ?? '');

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.brand} accessibilityRole="header">
              ITP Field
            </Text>
            <Text style={styles.subtitle}>Industrial troubleshooting &amp; maintenance</Text>

            {expired ? (
              <InlineBanner tone="warn">Your session expired. Sign in again to continue.</InlineBanner>
            ) : null}
            {formError ? <InlineBanner tone="error">{formError}</InlineBanner> : null}
            {loopbackWarning ? (
              <InlineBanner tone="warn">
                The API address points at this device itself (localhost). On a physical phone, set
                EXPO_PUBLIC_API_BASE_URL to your computer&apos;s network IP. See docs/EXPO_GO_SETUP.md.
              </InlineBanner>
            ) : null}

            <Controller
              control={control}
              name="email"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextField
                  label="Email"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  placeholder="you@company.com"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  error={errors.email?.message}
                  testID="login-email"
                />
              )}
            />
            <Controller
              control={control}
              name="password"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextField
                  label="Password"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  secure
                  error={errors.password?.message}
                  testID="login-password"
                />
              )}
            />
            <Button
              label="Sign in"
              onPress={() => void onSubmit()}
              loading={isSubmitting}
              size="lg"
              testID="login-submit"
            />
            <Text
              style={styles.link}
              accessibilityRole="link"
              onPress={() => router.push('/(auth)/forgot-password')}
            >
              Forgot password?
            </Text>
            <View style={{ height: spacing.xl }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  brand: { color: colors.text, fontSize: 32, fontWeight: '800', textAlign: 'center', marginTop: spacing.xl },
  subtitle: { color: colors.textMuted, fontSize: typeScale.small, textAlign: 'center', marginBottom: spacing.lg },
  link: { color: colors.primary, fontSize: typeScale.subheading, textAlign: 'center', paddingVertical: spacing.md },
});
