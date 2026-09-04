/**
 * Conversation chat.
 *
 * Every answer is produced by the backend RAG pipeline - the app never
 * generates technical content. Each assistant message renders its evidence
 * lanes (Manual / Historical / Maintenance) with citations; refusals and
 * clarification requests are shown verbatim, never softened or replaced.
 * Offline: cached messages are readable, sending is disabled with a clear
 * explanation (assistant answers need the pipeline).
 */
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, FlatList, TextInput } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import type { MessageView } from '@itp/shared';
import { useAuth } from '@/auth/auth-context';
import { useConversation, useMessages, useSendMessage } from '@/hooks/queries';
import { useNetwork } from '@/hooks/use-network';
import { citationsOf } from '@/lib/sources';
import { Badge, Button, Card } from '@/components/ui';
import { CachedNotice, ErrorState, InlineBanner, LoadingState } from '@/components/states';
import { MessageBubble } from '@/components/list-rows';
import { CitationCard } from '@/components/citations';
import { ragStatus, conversationStatus } from '@/lib/labels';
import { can } from '@/lib/permissions';
import { errorMessage } from '@/api/errors';
import { createIncidentFromConversation } from '@/api/endpoints';
import { colors, radius, spacing, type as typeScale } from '@/theme/tokens';

export default function ConversationScreen(): React.JSX.Element {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const { isOnline } = useNetwork();
  const conversationQuery = useConversation(userId, conversationId);
  const messagesQuery = useMessages(userId, conversationId);
  const sendMessage = useSendMessage(userId, conversationId);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [openCitationsFor, setOpenCitationsFor] = useState<MessageView | null>(null);
  const [creatingIncident, setCreatingIncident] = useState(false);
  const listRef = useRef<FlatList<MessageView>>(null);

  const conversation = conversationQuery.data?.data;
  const messages = (messagesQuery.data?.pages.flatMap((page) => page.items) ?? []).slice().sort((a, b) => {
    const seqA = Number((a as unknown as { sequence?: number }).sequence ?? 0);
    const seqB = Number((b as unknown as { sequence?: number }).sequence ?? 0);
    return seqA - seqB;
  });
  const readOnly = conversation ? conversation.status !== 'active' : false;
  const canAsk = can(user?.role, 'conversation.create');

  useEffect(() => {
    if (messages.length > 0) {
      // Keep the latest turn visible.
      const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 150);
      return () => clearTimeout(timer);
    }
  }, [messages.length]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sendMessage.isPending) return;
    setSendError(null);
    setDraft('');
    try {
      await sendMessage.mutateAsync({ content });
    } catch (error) {
      setSendError(errorMessage(error));
      setDraft(content);
    }
  };

  const citationsForLastAssistant = (() => {
    const last = [...messages].reverse().find((message) => message.role === 'assistant');
    return last ? citationsOf(last) : [];
  })();

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: conversation?.title || conversation?.machineLabel || 'Assistant',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {conversationQuery.isInitialLoading ? (
          <LoadingState label="Loading conversation…" />
        ) : conversationQuery.isError || !conversation ? (
          <ErrorState message={errorMessage(conversationQuery.error)} onRetry={() => void conversationQuery.refetch()} />
        ) : (
          <View style={{ flex: 1 }}>
            {conversationQuery.data?.cached ? <CachedNotice age="recent" /> : null}
            <View style={styles.contextRow}>
              <Badge {...conversationStatus(conversation.status)} size="sm" />
              {conversation.machineLabel ? <Text style={styles.contextText}>{conversation.machineLabel}</Text> : null}
            </View>

            <FlatList<MessageView>
              ref={listRef}
              data={messages}
              keyExtractor={(message) => message.id}
              contentContainerStyle={styles.list}
              onEndReached={() => {
                if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) void messagesQuery.fetchNextPage();
              }}
              ListEmptyComponent={
                messagesQuery.isInitialLoading ? (
                  <LoadingState label="Loading messages…" />
                ) : (
                  <Card>
                    <Text style={styles.hint}>
                      Describe the problem and ask a question. The assistant
                      answers only from the manuals, historical incidents and
                      maintenance records in scope for this machine.
                    </Text>
                  </Card>
                )
              }
              renderItem={({ item }) => {
                if (item.role === 'assistant' && item.ragStatus) {
                  const presentation = ragStatus(item.ragStatus);
                  return (
                    <View>
                      <MessageBubble message={item} />
                      {item.sources.length > 0 || citationsOf(item).length > 0 ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Show citations"
                          onPress={() => setOpenCitationsFor(item)}
                          style={styles.citationLink}
                        >
                          <Text style={styles.citationLinkText}>
                            ▤ {citationsOf(item).length} citation{citationsOf(item).length === 1 ? '' : 's'} ({presentation.label})
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                }
                return <MessageBubble message={item} />;
              }}
            />

            {citationsForLastAssistant.length > 0 ? (
              <View style={styles.legendRow}>
                <Text style={styles.legendText}>
                  Lanes: Manual (authoritative) · Historical (context only) · Maintenance (non-causal)
                </Text>
              </View>
            ) : null}

            {sendError ? <InlineBanner tone="error">{sendError}</InlineBanner> : null}

            {readOnly ? (
              <InlineBanner tone="warn">
                This conversation is {conversation.status}. Questions can only be asked in active conversations.
              </InlineBanner>
            ) : !isOnline ? (
              <InlineBanner tone="warn">
                The assistant needs a connection. Your cached conversation is readable; asking will resume when you are back online.
              </InlineBanner>
            ) : !canAsk ? (
              <InlineBanner tone="warn">Your role cannot send questions.</InlineBanner>
            ) : (
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Describe the problem or ask…"
                  placeholderTextColor={colors.textSubtle}
                  multiline
                  editable={!sendMessage.isPending}
                  accessibilityLabel="Question"
                />
                <Button label="Ask" onPress={() => void send()} loading={sendMessage.isPending} testID="chat-send" />
              </View>
            )}

            {can(user?.role, 'incident.create') && conversation.status === 'active' && messages.length > 0 ? (
              <View style={styles.incidentRow}>
                <Button
                  label="★ Create incident from this conversation"
                  variant="secondary"
                  loading={creatingIncident}
                  onPress={async () => {
                    setCreatingIncident(true);
                    try {
                      const incident = await createIncidentFromConversation(conversationId);
                      router.push(`/(app)/incidents/${incident.id}`);
                    } catch (error) {
                      setSendError(errorMessage(error));
                    } finally {
                      setCreatingIncident(false);
                    }
                  }}
                />
              </View>
            ) : null}
          </View>
        )}
      </KeyboardAvoidingView>

      <CitationsModal message={openCitationsFor} onClose={() => setOpenCitationsFor(null)} onOpenIncident={(id) => { setOpenCitationsFor(null); router.push(`/(app)/incidents/${id}`); }} />
    </SafeAreaView>
  );
}

function CitationsModal({
  message,
  onClose,
  onOpenIncident,
}: {
  message: MessageView | null;
  onClose: () => void;
  onOpenIncident: (incidentId: string) => void;
}): React.JSX.Element {
  if (!message) return <View />;
  const citations = citationsOf(message);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
        <View style={{ flex: 1, padding: spacing.md }}>
          <Text style={[{ color: colors.text, fontSize: typeScale.heading, fontWeight: '700', marginBottom: spacing.sm }]}>
            Evidence for this answer
          </Text>
          <ScrollView contentContainerStyle={{ paddingBottom: spacing.xl }}>
            {citations.map((citation) => (
              <CitationCard key={citation.key} citation={citation} onOpenIncident={onOpenIncident} />
            ))}
            <Button label="Close" variant="secondary" onPress={onClose} />
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  contextRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  contextText: { color: colors.textMuted, fontSize: typeScale.small, flexShrink: 1 },
  list: { padding: spacing.md, paddingBottom: spacing.sm, flexGrow: 1 },
  hint: { color: colors.textMuted, fontSize: typeScale.small, lineHeight: 20 },
  legendRow: { paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
  legendText: { color: colors.textSubtle, fontSize: typeScale.tiny },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, padding: spacing.md, paddingTop: spacing.xs },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: typeScale.body,
    paddingHorizontal: 12,
    minHeight: 48,
    maxHeight: 120,
    paddingTop: 12,
  },
  citationLink: { paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  citationLinkText: { color: colors.info, fontSize: typeScale.small },
  incidentRow: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
});
