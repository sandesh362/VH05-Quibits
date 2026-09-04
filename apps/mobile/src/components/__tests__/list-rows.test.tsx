/**
 * List row components: incidents, machines, conversations, actions, timeline,
 * outbox ops. These encode the "never colour alone" presentation contract.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import {
  IncidentRow,
  MachineRow,
  ConversationRow,
  ManualRow,
  IncidentActionRow,
  TimelineEventRow,
  OutboxOpRow,
  FixCard,
  RootCauseCard,
} from '@/components/list-rows';
import type { IncidentView, IncidentActionView, IncidentTimelineEventView } from '@itp/shared';
import type { MachineView, ManualView, ConversationListItem } from '@/api/types';

const now = new Date().toISOString();

const incident = {
  id: 'i1',
  incidentNumber: 'INC-2026-000001',
  organizationId: 'o',
  title: 'Hydraulic press loses pressure',
  description: '',
  source: 'other',
  machineId: 'm1',
  machineModelId: 'mm1',
  machineLabel: 'Press 3',
  machineModelLabel: 'HP-500',
  conversationId: null,
  manualId: null,
  manualVersion: null,
  reportedBy: 'u1',
  reportedByName: 'Tina',
  assignedTo: null,
  assignedToName: null,
  severity: 'critical',
  priority: 'high',
  status: 'open',
  issueStatus: 'investigating',
  symptoms: [],
  errorCodes: [],
  operatingConditions: [],
  firstObservedAt: now,
  lastObservedAt: null,
  rootCause: { text: null, status: 'unknown', confirmationNote: null, confirmedBy: null, confirmedAt: null, rejectionReason: null },
  temporaryFix: null,
  permanentFix: null,
  resolutionSummary: null,
  resolvedBy: null,
  resolvedAt: null,
  closedBy: null,
  closedAt: null,
  reopenedBy: null,
  reopenedAt: null,
  tags: [],
  attachments: [],
  embeddingStatus: 'not_indexed',
  embeddingError: null,
  createdAt: now,
  updatedAt: now,
} as unknown as IncidentView;

const machine = {
  id: 'm1',
  assetTag: 'PRESS-3',
  machineModelId: 'mm1',
  modelSnapshot: { manufacturer: 'Acme', modelName: 'HP-500', machineType: 'hydraulic_press' },
  displayName: 'Press 3',
  serialNumber: 'SN-9',
  location: { site: 'Plant 1' },
  status: 'down',
  installedAt: null,
  commissionedAt: null,
  criticality: 'critical',
  notes: null,
  lastMaintenanceAt: null,
  openIncidentCount: 2,
  createdAt: now,
  updatedAt: now,
} as unknown as MachineView;

describe('IncidentRow', () => {
  it('shows number, title, severity/status/issue badges and machine label', () => {
    const onPress = jest.fn();
    const { getByText, getByLabelText } = render(<IncidentRow incident={incident} onPress={onPress} />);
    expect(getByText('INC-2026-000001')).toBeTruthy();
    expect(getByText('Hydraulic press loses pressure')).toBeTruthy();
    expect(getByText('Critical')).toBeTruthy();
    expect(getByText('Open')).toBeTruthy();
    expect(getByText('Press 3')).toBeTruthy();
    fireEvent.press(getByLabelText(/INC-2026-000001/));
    expect(onPress).toHaveBeenCalled();
  });
});

describe('MachineRow', () => {
  it('shows name, asset tag, serial, model and open count', () => {
    const { getByText } = render(<MachineRow machine={machine} onPress={() => {}} />);
    expect(getByText('Press 3')).toBeTruthy();
    expect(getByText(/PRESS-3/)).toBeTruthy();
    expect(getByText(/HP-500/)).toBeTruthy();
    expect(getByText(/2 open incidents/)).toBeTruthy();
  });
});

describe('ConversationRow + ManualRow', () => {
  const conversation = {
    id: 'c1',
    title: null,
    createdBy: 'u1',
    machineId: 'm1',
    machineModelId: null,
    manualId: null,
    manualVersion: null,
    machineLabel: 'Press 3',
    machineModelLabel: null,
    manualTitle: null,
    status: 'active',
    issueStatus: 'investigating',
    issueSummary: null,
    errorCodes: [],
    symptoms: [],
    lastMessageAt: now,
    messageCount: 4,
    createdAt: now,
    updatedAt: now,
  } as unknown as ConversationListItem;

  const manual = {
    id: 'man1',
    title: 'HP-500 Service Manual',
    description: null,
    manufacturer: 'Acme',
    scope: 'model',
    machineModelId: 'mm1',
    machineId: null,
    documentType: 'service',
    documentNumber: null,
    documentVersion: '2.1',
    revision: null,
    isCurrentVersion: true,
    isActive: true,
    language: 'en',
    originalFilename: 'hp500.pdf',
    fileSizeBytes: 2048 * 1024,
    sha256: 'x',
    mimeType: 'application/pdf',
    pageCount: 120,
    processingStatus: 'completed',
    processingVersion: null,
    extractionMethod: 'pdf',
    ocrUsed: false,
    indexedChunkCount: 88,
    indexedAt: now,
    processedAt: now,
    failedAt: null,
    failureReason: null,
    isSearchable: true,
    uploadedBy: 'u1',
    createdAt: now,
    updatedAt: now,
  } as unknown as ManualView;

  it('conversation row renders title fallback and counts', () => {
    const { getByText } = render(<ConversationRow conversation={conversation} onPress={() => {}} />);
    expect(getByText('Press 3')).toBeTruthy();
    expect(getByText(/4 messages/)).toBeTruthy();
  });

  it('manual row renders version, type and searchable status', () => {
    const { getByText } = render(<ManualRow manual={manual} onPress={() => {}} />);
    expect(getByText('HP-500 Service Manual')).toBeTruthy();
    expect(getByText(/Searchable/)).toBeTruthy();
    expect(getByText(/2\.1/)).toBeTruthy();
  });
});

describe('IncidentActionRow', () => {
  const action = {
    id: 'a1',
    incidentId: 'i1',
    organizationId: 'o',
    actionType: 'technician',
    description: 'Cleaned the suction strainer',
    performedBy: 'u1',
    performedByName: 'Tina',
    sourceMessageId: null,
    sourceSuggestionId: null,
    sourceManualId: null,
    sourceManualVersion: null,
    result: 'Pressure restored',
    resultStatus: 'successful',
    confirmed: false,
    confirmedBy: null,
    confirmedAt: null,
    notes: null,
    performedAt: now,
    createdAt: now,
    updatedAt: now,
  } as unknown as IncidentActionView;

  it('labels technician actions and offers explicit confirmation', () => {
    const onConfirm = jest.fn();
    const { getByText, getByLabelText } = render(<IncidentActionRow action={action} onConfirm={onConfirm} />);
    expect(getByText('Technician')).toBeTruthy();
    expect(getByText('Successful')).toBeTruthy();
    expect(getByText('Unconfirmed')).toBeTruthy();
    fireEvent.press(getByLabelText('Confirm this action result'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('marks AI suggestions as suggestions, never technician work', () => {
    const { getByText, queryByLabelText } = render(
      <IncidentActionRow action={{ ...action, actionType: 'assistant_suggestion' }} />,
    );
    expect(getByText('AI suggestion')).toBeTruthy();
    expect(queryByLabelText('Confirm this action result')).toBeNull();
  });
});

describe('TimelineEventRow', () => {
  it('renders human labels for known event types', () => {
    const event = {
      id: 'e1',
      sequence: 1,
      type: 'status_changed',
      at: now,
      actorId: null,
      actorUsername: 'tina',
      previous: { status: 'open' },
      next: { status: 'investigating' },
      note: 'starting diagnosis',
    } as unknown as IncidentTimelineEventView;
    const { getByText } = render(<TimelineEventRow event={event} />);
    expect(getByText('Status changed')).toBeTruthy();
    expect(getByText(/Note: starting diagnosis/)).toBeTruthy();
  });

  it('does not crash on unknown event types', () => {
    const event = { id: 'e2', sequence: 2, type: 'some_new_event', at: now, actorId: null, actorUsername: null, note: null } as unknown as IncidentTimelineEventView;
    const { getByText } = render(<TimelineEventRow event={event} />);
    expect(getByText('some new event')).toBeTruthy();
  });
});

describe('OutboxOpRow', () => {
  const op = {
    id: 'op1',
    type: 'create_incident',
    status: 'requires_review' as const,
    createdAt: now,
    lastError: 'It is not known whether the server received this change.',
  };

  it('renders op label, review state and review/discard actions', () => {
    const onReview = jest.fn();
    const onDiscard = jest.fn();
    const { getByText, getByLabelText } = render(
      <OutboxOpRow op={op} onReview={onReview} onDiscard={onDiscard} />,
    );
    expect(getByText('Create incident')).toBeTruthy();
    expect(getByText('Needs review')).toBeTruthy();
    fireEvent.press(getByText('Review'));
    expect(onReview).toHaveBeenCalled();
    fireEvent.press(getByLabelText('Discard this queued change'));
    expect(onDiscard).toHaveBeenCalled();
  });
});

describe('FixCard + RootCauseCard labels', () => {
  it('fix cards distinguish recorded vs confirmed states', () => {
    const { rerender, getByText } = render(
      <FixCard kind="Temporary fix" fix={null} canRecord={false} canConfirm={false} onRecord={() => {}} onConfirm={() => {}} />,
    );
    expect(getByText('None recorded')).toBeTruthy();
    rerender(
      <FixCard
        kind="Temporary fix"
        fix={{ description: 'Clamped the leak', result: null, status: 'confirmed', confirmedAt: now, notes: null, recordedAt: now }}
        canRecord={false}
        canConfirm={false}
        onRecord={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(getByText('Confirmed')).toBeTruthy();
  });

  it('root-cause card shows suspected/confirmed/rejected labels', () => {
    const { getByText } = render(
      <RootCauseCard
        rootCause={{ text: 'Worn shaft seal', status: 'confirmed', confirmationNote: 'Verified by teardown', confirmedAt: now, rejectionReason: null }}
        canUpdate={false}
        onUpdate={() => {}}
        onConfirm={() => {}}
        onReject={() => {}}
      />,
    );
    expect(getByText('Confirmed')).toBeTruthy();
    expect(getByText('Worn shaft seal')).toBeTruthy();
  });
});
