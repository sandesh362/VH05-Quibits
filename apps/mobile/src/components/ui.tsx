/**
 * Base UI kit.
 *
 * Dark-first (matching the web design system), large touch targets (>= 48pt),
 * readable font sizes, high contrast. Status is never colour alone - every
 * Badge renders icon + label + tone.
 */
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, minTouchTarget, radius, spacing, toneBg, toneColor, type as typeScale, type Tone } from '@/theme/tokens';

// --- Button -----------------------------------------------------------------

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  style,
  testID,
  accessibilityLabel,
}: ButtonProps): React.JSX.Element {
  const isDanger = variant === 'danger';
  const isGhost = variant === 'ghost';
  const bg = isDanger ? colors.errorBg : isGhost ? 'transparent' : variant === 'primary' ? colors.primary : colors.surfaceRaised;
  const fg = isGhost ? colors.textMuted : variant === 'primary' ? '#ffffff' : isDanger ? colors.error : colors.text;
  const borderColor = isGhost ? 'transparent' : isDanger ? colors.error : variant === 'primary' ? colors.primary : colors.borderStrong;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        size === 'lg' && styles.buttonLg,
        { backgroundColor: bg, borderColor, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, { color: fg }]}>
        {loading ? 'Working…' : label}
      </Text>
    </Pressable>
  );
}

// --- Card ---------------------------------------------------------------------

export function Card({
  children,
  style,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): React.JSX.Element {
  return (
    <View testID={testID} style={[styles.card, style]}>
      {children}
    </View>
  );
}

// --- Badge ----------------------------------------------------------------------

export interface BadgeProps {
  icon: string;
  label: string;
  tone: Tone;
  size?: 'sm' | 'md';
  testID?: string;
}

export function Badge({ icon, label, tone, size = 'md', testID }: BadgeProps): React.JSX.Element {
  const bg = toneBg[tone];
  const fg = toneColor[tone];
  return (
    <View
      testID={testID}
      accessibilityLabel={`${label}`}
      style={[
        styles.badge,
        size === 'sm' && styles.badgeSm,
        { backgroundColor: bg, borderColor: fg },
      ]}
    >
      <Text style={[styles.badgeIcon, { color: fg }, size === 'sm' && styles.badgeIconSm]} aria-hidden>
        {icon}
      </Text>
      <Text style={[styles.badgeLabel, { color: fg }, size === 'sm' && styles.badgeLabelSm]}>{label}</Text>
    </View>
  );
}

// --- Choice group (severity / priority / type selectors) ----------------------------

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
  tone?: Tone;
}

export interface ChoiceGroupProps<T extends string> {
  label: string;
  options: Array<ChoiceOption<T>>;
  value: T | undefined;
  onChange: (value: T) => void;
  error?: string;
  testID?: string;
}

export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  error,
  testID,
}: ChoiceGroupProps<T>): React.JSX.Element {
  return (
    <View style={styles.fieldGroup} testID={testID}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.choiceRow}>
        {options.map((option) => {
          const selected = option.value === value;
          const toneColorValue = option.tone ? toneColor[option.tone] : colors.primary;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${label}: ${option.label}`}
              onPress={() => onChange(option.value)}
              style={[
                styles.choice,
                {
                  borderColor: selected ? toneColorValue : colors.borderStrong,
                  backgroundColor: selected ? toneBg[option.tone ?? 'info'] : colors.surface,
                },
              ]}
            >
              {option.icon ? (
                <Text style={[styles.choiceIcon, { color: selected ? toneColorValue : colors.textMuted }]} aria-hidden>
                  {option.icon}
                </Text>
              ) : null}
              <Text
                style={[
                  styles.choiceLabel,
                  { color: selected ? toneColorValue : colors.text },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

// --- Text fields ----------------------------------------------------------------------

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  error?: string;
  multiline?: boolean;
  secure?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  keyboardType?: 'default' | 'email-address' | 'numeric';
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function TextField({
  label,
  value,
  onChangeText,
  onBlur,
  placeholder,
  error,
  multiline = false,
  secure = false,
  autoCapitalize = 'sentences',
  keyboardType = 'default',
  accessibilityLabel,
  testID,
  style,
}: TextFieldProps): React.JSX.Element {
  return (
    <View style={[styles.fieldGroup, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={accessibilityLabel ?? label}
        style={[styles.input, multiline && styles.inputMultiline, error ? styles.inputError : null]}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={colors.textSubtle}
        secureTextEntry={secure}
        autoCapitalize={autoCapitalize}
        autoCorrect={!secure}
        keyboardType={keyboardType}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

// --- Section title / key-value ------------------------------------------------------------

export function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function KeyValue({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value ?? '—'}</Text>
    </View>
  );
}

// --- Stat tile ----------------------------------------------------------------------------

export function StatTile({
  label,
  count,
  tone = 'neutral',
  onPress,
  testID,
}: {
  label: string;
  count: number | null;
  tone?: Tone;
  onPress?: () => void;
  testID?: string;
}): React.JSX.Element {
  const content = (
    <>
      <Text style={[styles.statCount, { color: toneColor[tone] }]} testID={testID ? `${testID}-count` : undefined}>
        {count === null ? '—' : String(count)}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${count ?? 'unknown'}`} onPress={onPress} style={styles.statTile}>
        {content}
      </Pressable>
    );
  }
  return <View style={styles.statTile}>{content}</View>;
}

// --- Chip (static label chip) -----------------------------------------------------------------

export function Chip({ icon, label, tone = 'neutral' }: { icon?: string; label: string; tone?: Tone }): React.JSX.Element {
  return (
    <View style={[styles.chip, { backgroundColor: toneBg[tone], borderColor: toneColor[tone] }]}>
      {icon ? <Text style={{ color: toneColor[tone], marginRight: 4 }} aria-hidden>{icon}</Text> : null}
      <Text style={{ color: toneColor[tone], fontSize: typeScale.small }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLg: {
    minHeight: 56,
    paddingHorizontal: spacing.lg,
  },
  buttonLabel: {
    fontSize: typeScale.subheading,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignSelf: 'flex-start',
  },
  badgeSm: {
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  badgeIcon: { fontSize: 13 },
  badgeIconSm: { fontSize: 11 },
  badgeLabel: { fontSize: typeScale.small, fontWeight: '600' },
  badgeLabelSm: { fontSize: typeScale.tiny },
  fieldGroup: { marginBottom: spacing.md },
  fieldLabel: { color: colors.textMuted, fontSize: typeScale.small, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: typeScale.body,
    paddingHorizontal: 12,
    minHeight: minTouchTarget,
  },
  inputMultiline: { minHeight: 100, paddingTop: 10 },
  inputError: { borderColor: colors.error },
  errorText: { color: colors.error, fontSize: typeScale.small, marginTop: spacing.xs },
  sectionTitle: {
    color: colors.text,
    fontSize: typeScale.heading,
    fontWeight: '700',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: spacing.md,
  },
  kvLabel: { color: colors.textMuted, fontSize: typeScale.small, flexShrink: 0 },
  kvValue: { color: colors.text, fontSize: typeScale.small, textAlign: 'right', flexShrink: 1 },
  statTile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    minHeight: 84,
    justifyContent: 'center',
  },
  statCount: { fontSize: 28, fontWeight: '700' },
  statLabel: { color: colors.textMuted, fontSize: typeScale.tiny, textAlign: 'center', marginTop: 4 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    minHeight: minTouchTarget,
  },
  choiceIcon: { fontSize: 14 },
  choiceLabel: { fontSize: typeScale.small, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
});

export const uiStyles = styles as unknown as Record<string, StyleProp<ViewStyle | TextStyle>>;
