import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Tab = 'home' | 'jobs' | 'status';

type Conversation = {
  id: string;
  title: string;
  machine: string;
  issue: string;
  status: 'active' | 'closed';
  issueStatus: string;
  messages: number;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  rag?: string;
  sources?: { title: string; page: string }[];
};

const CONVERSATIONS: Conversation[] = [
  {
    id: 'c1',
    title: 'Hydraulic startup alarm',
    machine: 'Press Line A · H-204',
    issue: 'E-104 on cold start; pressure undershoot',
    status: 'active',
    issueStatus: 'investigating',
    messages: 6,
  },
  {
    id: 'c2',
    title: 'Spindle overheat at 80%',
    machine: 'CNC Cell 3 · VX-900',
    issue: 'Thermal trip after 12 min under load',
    status: 'active',
    issueStatus: 'temporary_fix',
    messages: 11,
  },
  {
    id: 'c3',
    title: 'Conveyor interlock fault',
    machine: 'Packaging · CV-12',
    issue: 'Door switch open while guards closed',
    status: 'closed',
    issueStatus: 'resolved',
    messages: 8,
  },
];

const STARTER_CHAT: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: 'H-204 throws E-104 on cold start. Hydraulic pressure undershoots for about 8 seconds then the alarm trips. What should I check first?',
  },
  {
    id: 'm2',
    role: 'assistant',
    rag: 'Answered from manuals',
    text:
      'E-104 is documented as low system pressure during the first pressure-build window after a cold start. The OEM sequence is: confirm tank level and oil temperature, then verify the suction strainer and the pressure transducer on the main manifold before adjusting the compensator.\n\nDo not bypass the alarm. If tank temperature is below 15 °C, the manual requires a warm-up cycle rather than an immediate production start.',
    sources: [
      { title: 'H-204 Hydraulic Service Manual v3.2', page: 'p. 41 — Cold start sequence' },
      { title: 'H-204 Fault Code Index', page: 'p. 18 — E-104' },
    ],
  },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [chat, setChat] = useState<ChatMessage[]>(STARTER_CHAT);

  const openJob = useMemo(
    () => CONVERSATIONS.find((c) => c.id === openId) ?? null,
    [openId],
  );

  function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    setChat((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', text },
      {
        id: `a-${Date.now()}`,
        role: 'assistant',
        rag: 'Answered from manuals',
        text:
          'Indexed manuals for this machine describe that next step as a verification, not a repair. Record the observed pressure, oil temperature, and whether the warm-up interlock was active. Suggested action: compare readings against the cold-start table, then log the technician action before closing the issue.\n\nDecision support only — verify against the OEM manual before acting.',
        sources: [{ title: 'H-204 Hydraulic Service Manual v3.2', page: 'p. 44 — Verification table' }],
      },
    ]);
    setDraft('');
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.logo}>⚙</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>Industrial Troubleshooting</Text>
          <Text style={styles.phase}>Local RAG · shop-floor technician app</Text>
        </View>
        <View style={styles.pill}>
          <View style={styles.dot} />
          <Text style={styles.pillText}>On-prem</Text>
        </View>
      </View>

      {openJob ? (
        <ChatScreen
          job={openJob}
          chat={chat}
          draft={draft}
          onDraft={setDraft}
          onSend={sendDraft}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {tab === 'home' && <HomeScreen onOpenJobs={() => setTab('jobs')} />}
            {tab === 'jobs' && <JobsScreen onOpen={(id) => setOpenId(id)} />}
            {tab === 'status' && <StatusScreen />}
          </ScrollView>
          <View style={styles.tabs}>
            <TabButton label="Home" active={tab === 'home'} onPress={() => setTab('home')} />
            <TabButton label="Troubleshoot" active={tab === 'jobs'} onPress={() => setTab('jobs')} />
            <TabButton label="Status" active={tab === 'status'} onPress={() => setTab('status')} />
          </View>
        </>
      )}
    </View>
  );
}

function HomeScreen({ onOpenJobs }: { onOpenJobs: () => void }) {
  return (
    <View>
      <Text style={styles.h1}>Floor assistant</Text>
      <Text style={styles.lead}>
        Grounded answers from indexed OEM manuals. No cloud models. Suggestions are decision
        support — not a work order to execute blindly.
      </Text>

      <View style={styles.row}>
        <StatCard label="Active jobs" value="2" tone="info" />
        <StatCard label="Resolved today" value="1" tone="ok" />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Shift snapshot</Text>
        <Row k="Plant" v="Line A · hydraulics + CNC" />
        <Row k="Retrieval" v="Qdrant + local embeddings" />
        <Row k="Generation" v="Ollama (on-prem)" />
        <Row k="Auth" v="Technician session" />
      </View>

      <Pressable style={styles.primary} onPress={onOpenJobs}>
        <Text style={styles.primaryText}>Open troubleshooting</Text>
      </Pressable>

      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>Safety</Text>
        <Text style={styles.bannerBody}>
          Isolate energy per LOTO before any physical check. Confirm the OEM procedure on the
          cited page before acting.
        </Text>
      </View>
    </View>
  );
}

function JobsScreen({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <View>
      <Text style={styles.h1}>Conversations</Text>
      <Text style={styles.lead}>Scoped to a machine or model so retrieval stays in the right manuals.</Text>
      {CONVERSATIONS.map((job) => (
        <Pressable key={job.id} style={styles.job} onPress={() => onOpen(job.id)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.jobTitle}>{job.title}</Text>
            <Text style={styles.jobIssue}>{job.issue}</Text>
            <Text style={styles.meta}>
              {job.machine} · {job.messages} messages
            </Text>
          </View>
          <View style={styles.badges}>
            <Badge
              label={job.status}
              tone={job.status === 'active' ? 'ok' : 'muted'}
            />
            <Badge label={job.issueStatus.replace('_', ' ')} tone="warn" />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function ChatScreen({
  job,
  chat,
  draft,
  onDraft,
  onSend,
  onBack,
}: {
  job: Conversation;
  chat: ChatMessage[];
  draft: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  onBack: () => void;
}) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.chatBar}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>← Jobs</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.chatTitle} numberOfLines={1}>
            {job.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {job.machine}
          </Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.chatBody}>
        {chat.map((m) => (
          <View key={m.id} style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}>
            {m.rag ? <Text style={styles.rag}>{m.rag}</Text> : null}
            <Text style={styles.bubbleText}>{m.text}</Text>
            {m.sources?.map((s) => (
              <Text key={s.page} style={styles.source}>
                {s.title} · {s.page}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={onDraft}
          placeholder="Describe the symptom or error code…"
          placeholderTextColor="#6b7484"
          style={styles.input}
          multiline
        />
        <Pressable style={styles.send} onPress={onSend}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function StatusScreen() {
  return (
    <View>
      <Text style={styles.h1}>Local stack</Text>
      <Text style={styles.lead}>Everything stays on the plant network. The browser never talks to the cloud.</Text>
      {[
        ['Express API', 'Connected', 'ok'],
        ['MongoDB', 'Healthy', 'ok'],
        ['Qdrant', 'Indexed', 'ok'],
        ['Ollama embeddings', 'Local', 'ok'],
        ['Incident memory', 'Not built', 'muted'],
      ].map(([name, label, tone]) => (
        <View key={name} style={styles.statusRow}>
          <Text style={styles.statusName}>{name}</Text>
          <Badge label={label} tone={tone as 'ok' | 'muted'} />
        </View>
      ))}
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'info' }) {
  return (
    <View style={[styles.stat, tone === 'ok' ? styles.statOk : styles.statInfo]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v}>{v}</Text>
    </View>
  );
}

function Badge({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'muted' }) {
  const bg = tone === 'ok' ? '#1f3d2a' : tone === 'warn' ? '#3d3218' : '#2a2f3a';
  const fg = tone === 'ok' ? '#3fb950' : tone === 'warn' ? '#d29922' : '#9aa3b2';
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0f1115' },
  header: {
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2f3a',
    backgroundColor: '#171a21',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logo: { fontSize: 22 },
  brand: { color: '#e6e9ef', fontWeight: '600', fontSize: 15 },
  phase: { color: '#6b7484', fontSize: 12, marginTop: 2 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(63,185,80,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#3fb950' },
  pillText: { color: '#3fb950', fontSize: 12, fontWeight: '600' },
  body: { padding: 16, paddingBottom: 32, gap: 12 },
  h1: { color: '#e6e9ef', fontSize: 24, fontWeight: '700', marginBottom: 6 },
  lead: { color: '#9aa3b2', fontSize: 14, lineHeight: 20, marginBottom: 14 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  stat: { flex: 1, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: '#2a2f3a' },
  statOk: { backgroundColor: 'rgba(63,185,80,0.12)' },
  statInfo: { backgroundColor: 'rgba(88,166,255,0.12)' },
  statValue: { color: '#e6e9ef', fontSize: 28, fontWeight: '700' },
  statLabel: { color: '#9aa3b2', marginTop: 4, fontSize: 13 },
  card: {
    backgroundColor: '#171a21',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  cardTitle: { color: '#e6e9ef', fontWeight: '600', marginBottom: 8 },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#2a2f3a',
  },
  k: { color: '#6b7484', fontSize: 13 },
  v: { color: '#e6e9ef', fontSize: 13, maxWidth: '62%', textAlign: 'right' },
  primary: {
    backgroundColor: '#58a6ff',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryText: { color: '#0f1115', fontWeight: '700', fontSize: 15 },
  banner: {
    backgroundColor: 'rgba(210,153,34,0.12)',
    borderLeftWidth: 3,
    borderLeftColor: '#d29922',
    padding: 12,
    borderRadius: 6,
  },
  bannerTitle: { color: '#d29922', fontWeight: '700', marginBottom: 4 },
  bannerBody: { color: '#e6e9ef', fontSize: 13, lineHeight: 18 },
  job: {
    backgroundColor: '#171a21',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    gap: 10,
  },
  jobTitle: { color: '#e6e9ef', fontWeight: '600', fontSize: 15 },
  jobIssue: { color: '#9aa3b2', marginTop: 4, fontSize: 13 },
  meta: { color: '#6b7484', marginTop: 6, fontSize: 12 },
  badges: { alignItems: 'flex-end', gap: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
  badgeText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#2a2f3a',
    backgroundColor: '#171a21',
    paddingBottom: 10,
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { backgroundColor: 'rgba(88,166,255,0.12)' },
  tabText: { color: '#9aa3b2', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#58a6ff' },
  chatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2f3a',
    backgroundColor: '#171a21',
  },
  back: { color: '#58a6ff', fontWeight: '600' },
  chatTitle: { color: '#e6e9ef', fontWeight: '600' },
  chatBody: { padding: 14, gap: 10, paddingBottom: 24 },
  bubble: { maxWidth: '92%', borderRadius: 12, padding: 12 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#1e3a5f' },
  bubbleAi: { alignSelf: 'flex-start', backgroundColor: '#171a21', borderWidth: 1, borderColor: '#2a2f3a' },
  rag: { color: '#3fb950', fontSize: 11, fontWeight: '700', marginBottom: 6 },
  bubbleText: { color: '#e6e9ef', fontSize: 14, lineHeight: 20 },
  source: { color: '#58a6ff', fontSize: 12, marginTop: 8 },
  composer: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a2f3a',
    backgroundColor: '#171a21',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    color: '#e6e9ef',
    backgroundColor: '#0f1115',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  send: { backgroundColor: '#58a6ff', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: '#0f1115', fontWeight: '700' },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#171a21',
    borderWidth: 1,
    borderColor: '#2a2f3a',
    borderRadius: 8,
    padding: 14,
    marginBottom: 8,
  },
  statusName: { color: '#e6e9ef', fontSize: 14 },
});
