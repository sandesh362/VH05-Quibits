/**
 * Form helpers: machine picker, tag list input, date-time field.
 * All Expo Go compatible - no custom native modules. The date picker uses
 * @react-native-community/datetimepicker, which ships inside Expo Go.
 */
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useEffect, useState } from 'react';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Button } from './ui';
import { LoadingState } from './states';
import type { MachineView } from '@/api/types';
import { useMachines } from '@/hooks/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { colors, minTouchTarget, radius, spacing, type as typeScale } from '@/theme/tokens';
import { Badge } from './ui';
import { machineStatus } from '@/lib/labels';

// --- Machine picker -------------------------------------------------------------

export function MachinePicker({
  visible,
  onClose,
  onSelect,
  title = 'Select machine',
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (machine: MachineView) => void;
  title?: string;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 350);
  const query = useMachines('picker', { search: debounced });
  const machines = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalScreen}>
        <Text style={styles.modalTitle}>{title}</Text>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, code or serial…"
          placeholderTextColor={colors.textSubtle}
          autoCapitalize="none"
          accessibilityLabel="Search machines"
        />
        {query.isInitialLoading ? (
          <LoadingState />
        ) : query.isError ? (
          <Text style={styles.errorText}>Cannot load machines. Check your connection.</Text>
        ) : machines.length === 0 ? (
          <Text style={styles.emptyText}>No machines match this search.</Text>
        ) : (
          <View>
            {machines.map((machine) => {
              const presentation = machineStatus(machine.status);
              return (
                <Pressable
                  key={machine.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${machine.displayName ?? machine.assetTag}`}
                  onPress={() => {
                    onSelect(machine);
                    onClose();
                  }}
                  style={({ pressed }) => [styles.machineRow, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.machineName}>{machine.displayName ?? machine.assetTag}</Text>
                    <Text style={styles.machineSub}>
                      {machine.assetTag}
                      {machine.serialNumber ? ` · SN ${machine.serialNumber}` : ''}
                      {machine.modelSnapshot ? ` · ${machine.modelSnapshot.modelName}` : ''}
                    </Text>
                  </View>
                  <Badge icon={presentation.icon} label={presentation.label} tone={presentation.tone} size="sm" />
                </Pressable>
              );
            })}
          </View>
        )}
        <Button label="Cancel" variant="secondary" onPress={onClose} style={styles.cancelButton} />
      </View>
    </Modal>
  );
}

// --- Tag list input (symptoms, error codes, conditions, tags) ---------------------------

export function TagListInput({
  label,
  values,
  onChange,
  placeholder,
  maxItems = 50,
  suggestions = [],
  testID,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  maxItems?: number;
  suggestions?: string[];
  testID?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || values.length >= maxItems || values.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...values, trimmed]);
    setDraft('');
  };

  const remove = (value: string) => onChange(values.filter((item) => item !== value));

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.tagWrap}>
        {values.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${value}`}
            onPress={() => remove(value)}
            style={styles.tag}
          >
            <Text style={styles.tagText}>{value} ✕</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.tagInputRow}>
        <TextInput
          testID={testID}
          style={styles.tagInput}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onEndEditing={commit}
          onBlur={commit}
          placeholder={placeholder}
          placeholderTextColor={colors.textSubtle}
          returnKeyType="done"
          accessibilityLabel={label}
        />
        <Button label="Add" variant="secondary" onPress={commit} />
      </View>
      {suggestions.length > 0 ? (
        <View style={styles.tagWrap}>
          {suggestions
            .filter((suggestion) => !values.includes(suggestion))
            .slice(0, 8)
            .map((suggestion) => (
              <Pressable
                key={suggestion}
                accessibilityRole="button"
                accessibilityLabel={`Add ${suggestion}`}
                onPress={() => !values.includes(suggestion) && onChange([...values, suggestion])}
                style={styles.suggestion}
              >
                <Text style={styles.suggestionText}>+ {suggestion}</Text>
              </Pressable>
            ))}
        </View>
      ) : null}
    </View>
  );
}

// --- Date-time field ---------------------------------------------------------------------

function toLocalInputValue(date: Date): string {
  // ISO with local offset is what the backend date schema accepts.
  return date.toISOString();
}

export function DateTimeField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string | undefined;
  onChange: (iso: string | undefined) => void;
  error?: string;
}): React.JSX.Element {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerDate, setPickerDate] = useState<Date>(() => (value ? new Date(value) : new Date()));

  useEffect(() => {
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) setPickerDate(parsed);
    }
  }, [value]);

  const display = value ? new Date(value).toLocaleString() : 'Not set';

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.dateTimeRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${display}. Tap to change.`}
          onPress={() => setShowPicker(true)}
          style={styles.dateTimeButton}
        >
          <Text style={styles.dateTimeText}>{display}</Text>
        </Pressable>
        {value ? (
          <Button label="Clear" variant="ghost" onPress={() => onChange(undefined)} />
        ) : null}
      </View>
      {showPicker ? (
        <View>
          <DateTimePicker
            value={pickerDate}
            mode="datetime"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(event, date) => {
              if (Platform.OS === 'android') {
                setShowPicker(false);
              }
              if (event.type === 'set' && date) {
                setPickerDate(date);
                onChange(toLocalInputValue(date));
                if (Platform.OS === 'ios') setShowPicker(false);
              }
            }}
          />
          {Platform.OS === 'ios' ? (
            <Button label="Done" variant="secondary" onPress={() => setShowPicker(false)} />
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  modalScreen: { flex: 1, backgroundColor: colors.bg, padding: spacing.md, paddingTop: spacing.xl },
  modalTitle: { color: colors.text, fontSize: typeScale.heading, fontWeight: '700', marginBottom: spacing.md },
  searchInput: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: typeScale.body,
    paddingHorizontal: 12,
    minHeight: minTouchTarget,
    marginBottom: spacing.md,
  },
  machineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: minTouchTarget,
  },
  machineName: { color: colors.text, fontSize: typeScale.body, fontWeight: '600' },
  machineSub: { color: colors.textMuted, fontSize: typeScale.small, marginTop: 2 },
  cancelButton: { marginTop: spacing.sm },
  errorText: { color: colors.error, fontSize: typeScale.small, marginTop: spacing.xs },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg },
  fieldGroup: { marginBottom: spacing.md },
  fieldLabel: { color: colors.textMuted, fontSize: typeScale.small, marginBottom: spacing.xs },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  tag: {
    backgroundColor: colors.primaryBg,
    borderColor: colors.primary,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tagText: { color: colors.primary, fontSize: typeScale.small },
  tagInputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  tagInput: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: typeScale.body,
    paddingHorizontal: 12,
    minHeight: minTouchTarget,
  },
  suggestion: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  suggestionText: { color: colors.textMuted, fontSize: typeScale.small },
  dateTimeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dateTimeButton: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    minHeight: minTouchTarget,
    justifyContent: 'center',
  },
  dateTimeText: { color: colors.text, fontSize: typeScale.body },
});
