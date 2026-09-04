import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConversationDetailPage } from './conversation-detail-page';
import { AuthProvider } from '../lib/auth';
import { apiClient, ApiClientError, type MessageRecord } from '../lib/api-client';

const conversation = {
  id: 'c1',
  title: 'Hydraulic startup alarm',
  createdBy: 'u1',
  machineId: 'm1',
  machineModelId: 'model1',
  manualId: null,
  manualVersion: null,
  machineLabel: 'Press 12',
  machineModelLabel: 'Haas VF-2',
  manualTitle: 'Hydraulic Service Manual',
  status: 'active',
  issueStatus: 'investigating',
  issueSummary: 'Hydraulic pressure drops during startup',
  errorCodes: ['E-104'],
  symptoms: ['Pressure drop'],
  lastMessageAt: '2026-09-04T10:00:00.000Z',
  messageCount: 2,
  createdAt: '2026-09-04T09:00:00.000Z',
  updatedAt: '2026-09-04T10:00:00.000Z',
};

const answered: MessageRecord = {
  id: 'msg-a',
  conversationId: 'c1',
  role: 'assistant',
  messageType: 'answer',
  content: 'The selected manual identifies low hydraulic pressure during startup.',
  status: 'completed',
  sources: [
    {
      sourceId: 'source-1',
      chunkId: 'chunk-1',
      manualId: 'man-1',
      manualTitle: 'Hydraulic Service Manual',
      manualVersion: '2.1',
      pageStart: 42,
      pageEnd: 43,
      sectionTitle: 'Startup alarms',
      excerpt: 'E-104 indicates low hydraulic pressure during startup.',
    },
  ],
  suggestedActions: [
    { id: 'suggestion-1', description: 'Check the hydraulic fluid level.', sourceIds: ['source-1'], status: 'suggested' },
  ],
  clarification: null,
  refusalReason: null,
  ragStatus: 'answered',
  confidence: 'medium',
  createdAt: '2026-09-04T10:00:00.000Z',
};

function seedSession(): void {
  sessionStorage.setItem('itp.accessToken', 'token');
  sessionStorage.setItem(
    'itp.user',
    JSON.stringify({
      id: 'u1',
      username: 'tech',
      email: 'tech@example.test',
      fullName: 'Tech',
      role: 'technician',
      isActive: true,
      mustChangePassword: false,
      lastLoginAt: null,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    }),
  );
}

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={['/conversations/c1']}>
      <AuthProvider>
        <Routes>
          <Route path="/conversations/:id" element={<ConversationDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ConversationDetailPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    seedSession();
    vi.restoreAllMocks();
    vi.spyOn(apiClient, 'getConversation').mockResolvedValue({ conversation });
    vi.spyOn(apiClient, 'listMessages').mockResolvedValue({
      data: [
        {
          id: 'msg-u',
          conversationId: 'c1',
          role: 'user',
          messageType: 'question',
          content: 'Why is error E-104 appearing during hydraulic startup?',
          status: 'completed',
          sources: [],
          suggestedActions: [],
          clarification: null,
          refusalReason: null,
          ragStatus: null,
          confidence: null,
          createdAt: '2026-09-04T09:59:00.000Z',
        },
        answered,
      ],
      meta: undefined,
      status: 200,
    });
    vi.spyOn(apiClient, 'listActions').mockResolvedValue({ data: [], meta: undefined, status: 200 });
  });

  it('renders citations without filesystem paths and keeps suggestions separate from actions', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText(/Hydraulic Service Manual, version 2.1, pages 42–43/)).toBeInTheDocument());
    expect(screen.getByText(/Suggested checks \(not performed\)/)).toBeInTheDocument();
    expect(screen.getByText(/No technician-confirmed actions yet/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\/home\/|storage_path/);
  });

  it('opens a source preview from the citation', async () => {
    renderDetail();
    const citation = await screen.findByRole('button', { name: /Hydraulic Service Manual/ });
    await userEvent.click(citation);
    expect(await screen.findByRole('dialog')).toHaveTextContent('E-104 indicates low hydraulic pressure during startup.');
    expect(screen.getByText('source-1')).toBeInTheDocument();
  });

  it('shows a refusal when evidence is insufficient', async () => {
    vi.spyOn(apiClient, 'listMessages').mockResolvedValue({
      data: [
        {
          ...answered,
          id: 'msg-r',
          messageType: 'refusal',
          ragStatus: 'insufficient_evidence',
          content: 'The manuals in scope do not contain enough evidence to answer reliably.',
          sources: [],
          suggestedActions: [],
          refusalReason: 'INSUFFICIENT_EVIDENCE',
        },
      ],
      meta: undefined,
      status: 200,
    });
    renderDetail();
    expect(await screen.findByText(/Insufficient evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/INSUFFICIENT_EVIDENCE/)).toBeInTheDocument();
  });

  it('keeps the question and offers retry when send fails', async () => {
    vi.spyOn(apiClient, 'sendMessage').mockRejectedValue(
      new ApiClientError('DEPENDENCY_UNAVAILABLE', 'The retrieval service is unreachable.', 503),
    );
    renderDetail();
    await screen.findByText(/Hydraulic startup alarm/);
    await userEvent.type(screen.getByLabelText(/question/i), 'What should I check first?');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(await screen.findByText(/Your question was kept/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
