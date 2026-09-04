/**
 * Assistant tab - the technician's conversation list.
 *
 * Every answer comes from the backend RAG pipeline; this screen only lists
 * existing conversations and starts new ones (with a machine selected first).
 */
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/auth-context';
import { useConversations } from '@/hooks/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Button, TextField } from '@/components/ui';
import { EmptyState, ErrorState, SkeletonList } from '@/components/states';
import { ConversationRow } from '@/components/list-rows';
import type { ConversationListItem } from '@/api/types';
import { errorMessage } from '@/api/errors';
import { colors, spacing } from '@/theme/tokens';

export default function AssistantScreen(): React.JSX.Element {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 350);
  const query = useConversations(userId, debounced);
  const conversations = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Assistant',
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      />
      <FlatList<ConversationListItem>
        data={conversations}
        keyExtractor={(conversation) => conversation.id}
        contentContainerStyle={styles.content}
        refreshing={query.isRefetching}
        onRefresh={() => void query.refetch()}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={styles.header}>
            <Button
              label="✦  New conversation"
              size="lg"
              onPress={() => router.push('/(app)/conversations/new')}
              testID="assistant-new"
            />
            <View style={{ height: spacing.md }} />
            <TextField
              label="Search conversations"
              value={search}
              onChangeText={setSearch}
              placeholder="Title or machine…"
              autoCapitalize="none"
            />
          </View>
        }
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            onPress={() => router.push(`/(app)/conversations/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          query.isInitialLoading ? (
            <SkeletonList rows={5} />
          ) : query.isError ? (
            <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
          ) : (
            <EmptyState
              title="No conversations yet"
              message="Start a conversation to ask the troubleshooting assistant about a machine."
            />
          )
        }
        ListFooterComponent={
          query.isFetchingNextPage ? <Text style={styles.footer}>Loading more…</Text> : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  header: { marginBottom: spacing.sm },
  footer: { color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.md },
});
