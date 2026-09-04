import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Appearance } from 'react-native';
import { darkColors, lightColors, type AppColors, type ThemeMode } from './tokens';

interface ThemeContextValue {
  colors: AppColors;
  mode: ThemeMode;
  isDark: boolean;
  toggleTheme: () => void;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const fallbackTheme: ThemeContextValue = {
  colors: darkColors,
  mode: 'dark',
  isDark: true,
  toggleTheme: () => {},
  setThemeMode: () => {},
};

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const systemScheme = Appearance.getColorScheme();
  const [mode, setMode] = useState<ThemeMode>(systemScheme === 'light' ? 'light' : 'dark');
  const colors = mode === 'dark' ? darkColors : lightColors;

  const value = useMemo<ThemeContextValue>(
    () => ({
      colors,
      mode,
      isDark: mode === 'dark',
      toggleTheme: () => setMode((current) => (current === 'dark' ? 'light' : 'dark')),
      setThemeMode: setMode,
    }),
    [colors, mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  return theme ?? fallbackTheme;
}
