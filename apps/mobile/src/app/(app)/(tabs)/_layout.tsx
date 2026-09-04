/**
 * Main tabs: Home · My Work · Machines · Assistant · Profile.
 * Text-glyph icons (matching the web's "never colour alone" convention).
 */
import { Tabs } from 'expo-router';
import { Text, StyleSheet } from 'react-native';
import { type as typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/theme-context';

const ICONS: Record<string, string> = {
  home: '⌂',
  work: '☑',
  machines: '⚙',
  assistant: '✦',
  profile: '👤',
};

function TabIcon({ name, focused }: { name: string; focused: boolean }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Text style={[styles.icon, { color: focused ? colors.primary : colors.textMuted }]} aria-hidden>
      {ICONS[name] ?? '·'}
    </Text>
  );
}

export default function TabsLayout(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          minHeight: 60,
          paddingBottom: 6,
          paddingTop: 6,
        },
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{ title: 'Home', tabBarIcon: ({ focused }) => <TabIcon name="home" focused={focused} /> }}
      />
      <Tabs.Screen
        name="work"
        options={{ title: 'My Work', tabBarIcon: ({ focused }) => <TabIcon name="work" focused={focused} /> }}
      />
      <Tabs.Screen
        name="machines"
        options={{ title: 'Machines', tabBarIcon: ({ focused }) => <TabIcon name="machines" focused={focused} /> }}
      />
      <Tabs.Screen
        name="assistant"
        options={{ title: 'Assistant', tabBarIcon: ({ focused }) => <TabIcon name="assistant" focused={focused} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: ({ focused }) => <TabIcon name="profile" focused={focused} /> }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: { fontSize: 20, lineHeight: 24 },
  label: { fontSize: typeScale.tiny },
});
