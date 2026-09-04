/**
 * Incident edit (own/any per backend policy).
 *
 * Same field-friendly form as creation minus machine selection (the machine
 * link is immutable here; model changes are a manager workflow on the web).
 * Submitted through the outbox; the server re-validates everything.
 */
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import type { IncidentView } from '@itp/shared';
import { useAuth } from '@/auth/auth-context';
import { useIncident, useQueuedWrite } from '@/hooks/queries';
import { updateIncidentFormSchema, type UpdateIncidentValues } from '@/validation/schemas';
import { Button, Card, ChoiceGroup, SectionTitle, TextField } from '@/components/ui';
import { DateTimeField, TagListInput } from '@/components/forms';
import { InlineBanner, LoadingState, ErrorState } from '@/components/states';
import { PRIORITIES, SEVERITIES } from '@itp/shared';
import { severity as severityPresentation, priority as priorityPresentation } from '@/lib/labels';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function EditIncidentScreen(): React.JSX.Element {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const incidentQuery = useIncident(userId, incidentId);
  const queued = useQueuedWrite(userId);
  const [feedback, setFeedback] = useState<string | null>(null);
  const incident: IncidentView | undefined = incidentQuery.data?.data;

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UpdateIncidentValues>({
    resolver: zodResolver(updateIncidentFormSchema),
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

  useEffect(() => {
    if (incident) {
      reset({
        title: incident.title,
        description: incident.description,
        severity: incident.severity,
        priority: incident.priority,
        symptoms: incident.symptoms,
        errorCodes: incident.errorCodes,
        operatingConditions: incident.operatingConditions,
        tags: incident.tags,
        firstObservedAt: incident.firstObservedAt,
      });
    }
  }, [incident, reset]);

  if (incidentQuery.isInitialLoading) {
    return (
      <SafeAreaView style={styles.screen} edges={['bottom']}>
        <Stack.Screen options={{ headerShown: true, title: 'Edit incident', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
        <LoadingState />
      </SafeAreaView>
    );
  }
  if (incidentQuery.isError || !incident) {
    return (
      <SafeAreaView style={styles.screen} edges={['bottom']}>
        <Stack.Screen options={{ headerShown: true, title: 'Edit incident', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
        <ErrorState message={errorMessage(incidentQuery.error)} onRetry={() => void incidentQuery.refetch()} />
      </SafeAreaView>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    setFeedback(null);
    const outcome = await queued.mutateAsync({
      type: 'update_incident',
      payload: {
        incidentId: incident.id,
        body: {
          title: values.title,
          description: values.description,
          severity: values.severity,
          priority: values.priority,
          symptoms: values.symptoms,
          errorCodes: values.errorCodes,
          operatingConditions: values.operatingConditions,
          tags: values.tags,
          firstObservedAt: values.firstObservedAt,
        },
      },
    });
    if (outcome.kind === 'completed') {
      router.back();
    } else if (outcome.kind === 'queued') {
      setFeedback('Saved on this device. It syncs when you are connected.');
    } else if (outcome.kind === 'failed') {
      setFeedback(outcome.op.lastError ?? 'The server rejected this update.');
    } else {
      setFeedback('The server did not confirm this update. Review it in Profile → Queued changes.');
    }
  });

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: 'Edit incident', headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.text }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {feedback ? <InlineBanner tone="warn">{feedback}</InlineBanner> : null}
          <Card>
            <Text style={styles.note}>
              Technicians can edit incidents they reported while the incident is
              open or investigating. The machine link is changed by managers.
            </Text>
          </Card>

          <Controller
            control={control}
            name="title"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextField label="Title" value={value} onChangeText={onChange} onBlur={onBlur} error={errors.title?.message} />
            )}
          />
          <Controller
            control={control}
            name="description"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextField label="What happened?" value={value} onChangeText={onChange} onBlur={onBlur} multiline error={errors.description?.message} />
            )}
          />
          <Controller
            control={control}
            name="severity"
            render={({ field: { onChange, value } }) => (
              <ChoiceGroup
                label="Severity"
                options={SEVERITIES.map((entry) => ({
                  value: entry,
                  label: severityPresentation(entry).label,
                  icon: severityPresentation(entry).icon,
                  tone: severityPresentation(entry).tone,
                }))}
                value={value}
                onChange={onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="priority"
            render={({ field: { onChange, value } }) => (
              <ChoiceGroup
                label="Priority"
                options={PRIORITIES.map((entry) => ({
                  value: entry,
                  label: priorityPresentation(entry).label,
                  icon: priorityPresentation(entry).icon,
                  tone: priorityPresentation(entry).tone,
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
              <TagListInput label="Symptoms" values={value} onChange={onChange} placeholder="Add a symptom" />
            )}
          />
          <Controller
            control={control}
            name="errorCodes"
            render={({ field: { onChange, value } }) => (
              <TagListInput label="Error codes" values={value} onChange={onChange} placeholder="Add an error code" />
            )}
          />
          <Controller
            control={control}
            name="operatingConditions"
            render={({ field: { onChange, value } }) => (
              <TagListInput label="Operating conditions" values={value} onChange={onChange} placeholder="Add a condition" />
            )}
          />
          <Controller
            control={control}
            name="tags"
            render={({ field: { onChange, value } }) => (
              <TagListInput label="Tags" values={value} onChange={onChange} placeholder="Add a tag" maxItems={20} />
            )}
          />
          <Controller
            control={control}
            name="firstObservedAt"
            render={({ field: { onChange, value } }) => <DateTimeField label="First observed" value={value} onChange={onChange} />}
          />

          <Button label="Save changes" size="lg" onPress={() => void onSubmit()} loading={isSubmitting || queued.isPending} />
          <View style={{ height: spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  note: { color: colors.textMuted, fontSize: 13 },
});
