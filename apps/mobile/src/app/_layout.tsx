/**
 * Root layout: providers + auth gate.
 *
 * Providers: QueryClient (with NetInfo-driven online state), AuthProvider
 * (SecureStore session), sync engine. The splash screen stays visible until
 * the stored session has been checked, so protected screens never flash for
 * unauthenticated users.
 */
import { useEffect, useMemo, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { Stack, router, usePathname } from 'expo-router';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { AppState, Platform } from 'react-native';
import { AuthProvider, useAuth } from '@/auth/auth-context';
import { useOnlineManager } from '@/hooks/use-network';
import { authRedirect } from '@/lib/navigation';
import { initDatabase } from '@/db/database';
import { ThemeProvider, useTheme } from '@/theme/theme-context';

SplashScreen.preventAutoHideAsync().catch(() => {});

// React Query focus handling for React Native (AppState instead of visibility).
focusManager.setEventListener((handle) => {
  const subscription = AppState.addEventListener('change', (state) => {
    handle(state === 'active');
  });
  return () => subscription.remove();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false,
    },
  },
});

initDatabase();

function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'loading') return;
    SplashScreen.hideAsync().catch(() => {});
  }, [status]);

  useEffect(() => {
    const target = authRedirect(pathname, status);
    if (target) router.replace(target as never);
  }, [status, pathname]);

  return <>{children}</>;
}

export default function RootLayout(): React.JSX.Element {
  return (
    <ThemeProvider>
      <RootLayoutContent />
    </ThemeProvider>
  );
}

function RootLayoutContent(): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const theme = useTheme();
  useEffect(() => {
    // Give the DB a tick to initialize before rendering routes.
    setReady(true);
  }, []);

  useOnlineManager();

  const screenOptions = useMemo(
    () => ({
      headerShown: false,
      contentStyle: { backgroundColor: theme.colors.bg },
      animation: Platform.OS === 'android' ? ('fade_from_bottom' as const) : ('default' as const),
    }),
    [theme.colors.bg],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthGate>
              {ready ? (
                <Stack screenOptions={screenOptions}>
                  <Stack.Screen name="index" />
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(app)" />
                  <Stack.Screen name="+not-found" />
                </Stack>
              ) : null}
              <StatusBar style={theme.isDark ? 'light' : 'dark'} />
            </AuthGate>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
