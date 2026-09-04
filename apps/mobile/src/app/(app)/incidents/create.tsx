/**
 * Incident creation.
 *
 * Field-friendly: machine picker with recent machines, symptom chips with
 * suggestions, severity/priority buttons, date-time picker. Validation is
 * client-side (mirrors the backend validators); the backend remains the final
 * authority. Submission always goes through the outbox, so it also works
 * offline - the result is clearly communicated (queued vs saved).
 */
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import { createIncidentSchema, type CreateIncidentValues } from '@/validation/schemas';
import { useQueuedWrite, useRecents } from '@/hooks/queries';
import { Button, Card, ChoiceGroup, SectionTitle, TextField } from '@/components/ui';
import { DateTimeField, MachinePicker, TagListInput } from '@/components/forms';
import { InlineBanner } from '@/components/states';
import type { MachineView } from '@/api/types';
import { PRIORITIES, SEVERITIES } from '@itp/shared';
import { severity as severityPresentation, priority as priorityPresentation } from '@/lib/labels';
import { errorMessage } from '@/api/errors';
import { colors, spacing, type as typeScale } from '@/theme/tokens';

const SYMPTOM_SUGGESTIONS = [
  'unusual noise',
  'vibration',
  'overheating',
  'leak',
  'error code on HMI',
  'won\'t start',
  'stops mid-cycle',
  'low pressure',
];

export default function CreateIncidentScreen(): React.JSX.Element {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const queued = useQueuedWrite(userId);
  const recents = useRecents(userId, 'machines');
  const [pickerVisible, setPickerVisible] = useState(false);
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateIncidentValues>({
    resolver: zodResolver(createIncidentSchema),
    defaultValues: {
      title: '',
      description: '',
      severity: 'medium',
      priority: 'medium',
      symptoms: [],
      errorCodes: [],
      operatingConditions: [],
      tags: [],
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (!machine) return;
    setResultNote(null);
    const result = await queued.mutateAsync({
      type: 'create_incident',
      payload: {
        title: values.title,
        description: values.description,
        machineId: machine.id,
        ...(machine.machineModelId ? { machineModelId: machine.machineModelId } : {}),
        severity: values.severity,
        priority: values.priority,
        symptoms: values.symptoms,
        errorCodes: values.errorCodes,
        operatingConditions: values.operatingConditions,
        tags: values.tags,
        firstObservedAt: values.firstObservedAt,
        source: 'other',
        ...(values.conversationId ? { conversationId: values.conversationId } : {}),
        ...(values.manualId ? { manualId: values.manualId, manualVersion: values.manualVersion } : {}),
      },
    });
    if (result.kind === 'completed') {
      const incidentId = result.op.serverResult?.incidentId;
      router.replace(incidentId ? `/(app)/incidents/${incidentId}` : '/(app)/(tabs)/work');
      return;
    }
    if (result.kind === 'queued') {
      setResultNote('Saved on this device. It will sync automatically when you have a connection.');
    } else if (result.kind === 'failed') {
      setResultNote(`The server rejected this report: ${result.op.lastError ?? 'validation failed'}`);
    } else {
      setResultNote('The server did not confirm this report. Open Profile → Queued changes to review it.');
    }
  });

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Report incident',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {resultNote ? <InlineBanner tone="warn">{resultNote}</InlineBanner> : null}

          <SectionTitle>Machine</SectionTitle>
          <Card>
            {machine ? (
              <View>
                <Text style={styles.machineName}>{machine.displayName ?? machine.assetTag}</Text>
                <Text style={styles.machineSub}>
                  {machine.assetTag}
                  {machine.modelSnapshot ? ` · ${machine.modelSnapshot.modelName}` : ''}
                </Text>
              </View>
            ) : (
              <Text style={styles.machineSub}>Select the physical machine this incident is about.</Text>
            )}
            <View style={{ height: spacing.sm }} />
            <Button
              label={machine ? 'Change machine' : 'Select machine'}
              variant="secondary"
              onPress={() => setPickerVisible(true)}
              testID="incident-machine-picker"
            />
            {recents.length > 0 && !machine ? (
              <View style={styles.recentWrap}>
                {recents.slice(0, 4).map((recent) => (
                  <Button
                    key={recent.id}
                    label={`↺ ${recent.label}`}
                    variant="ghost"
                    onPress={() => setMachine({ id: recent.id, assetTag: recent.label, machineModelId: '' } as MachineView)}
                  />
                ))}
              </View>
            ) : null}
            {errors.machineId ? <Text style={styles.error}>{errors.machineId.message}</Text> : null}
          </Card>

          <Controller
            control={control}
            name="title"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextField
                label="Title"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                error={errors.title?.message}
                testID="incident-title"
              />
            )}
          />
          <Controller
            control={control}
            name="description"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextField
                label="What happened?"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                multiline
                error={errors.description?.message}
                testID="incident-description"
              />
            )}
          />

          <Controller
            control={control}
            name="severity"
            render={({ field: { onChange, value } }) => (
              <ChoiceGroup
                label="Severity"
                options={SEVERITIES.map((value) => ({
                  value,
                  label: severityPresentation(value).label,
                  icon: severityPresentation(value).icon,
                  tone: severityPresentation(value).tone,
                }))}
                value={value}
                onChange={onChange}
                testID="incident-severity"
              />
            )}
          />
          <Controller
            control={control}
            name="priority"
            render={({ field: { onChange, value } }) => (
              <ChoiceGroup
                label="Priority"
                options={PRIORITIES.map((value) => ({
                  value,
                  label: priorityPresentation(value).label,
                  icon: priorityPresentation(value).icon,
                  tone: priorityPresentation(value).tone,
                }))}
                value={value}
                onChange={onChange}
              />
            )}
          />

          <Controller
            control={control}
            name="symptoms"
            render={({ field: { onChange, value } }) => (
              <TagListInput
                label="Symptoms"
                values={value}
                onChange={onChange}
                placeholder="e.g. grinding noise from spindle"
                suggestions={SYMPTOM_SUGGESTIONS}
                testID="incident-symptoms"
              />
            )}
          />
          <Controller
            control={control}
            name="errorCodes"
            render={({ field: { onChange, value } }) => (
              <TagListInput label="Error codes" values={value} onChange={onChange} placeholder="e.g. E-104" testID="incident-error-codes" />
            )}
          />
          <Controller
            control={control}
            name="operatingConditions"
            render={({ field: { onChange, value } }) => (
              <TagListInput
                label="Operating conditions"
                values={value}
                onChange={onChange}
                placeholder="e.g. high load, cold start"
              />
            )}
          />
          <Controller
            control={control}
            name="tags"
            render={({ field: { onChange, value } }) => (
              <TagListInput label="Tags" values={value} onChange={onChange} placeholder="e.g. hydraulics" maxItems={20} />
            )}
          />
          <Controller
            control={control}
            name="firstObservedAt"
            render={({ field: { onChange, value } }) => (
              <DateTimeField label="First observed" value={value} onChange={onChange} />
            )}
          />

          <Button
            label="Report incident"
            size="lg"
            onPress={() => void onSubmit()}
            loading={isSubmitting || queued.isPending}
            testID="incident-submit"
          />
          <Text style={styles.hint}>
            Works offline: if there is no connection the report is saved on this
            device and synced later. Nothing is marked as “reported” until the
            server confirms it.
          </Text>
          <View style={{ height: spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
      <MachinePicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={setMachine}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  machineName: { color: colors.text, fontSize: typeScale.body, fontWeight: '700' },
  machineSub: { color: colors.textMuted, fontSize: typeScale.small, marginTop: 2 },
  recentWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  error: { color: colors.error, fontSize: typeScale.small, marginTop: spacing.xs },
  hint: { color: colors.textSubtle, fontSize: typeScale.tiny, marginTop: spacing.md, textAlign: 'center' },
});
