/**
 * Permissions mirror, labels, source lanes, formatting, navigation guards.
 */
import { can, canAttempt, capabilitiesOf } from './permissions';
import { incidentStatus, severity, ragStatus, syncOpStatus, actionResultStatus, outboxOpLabel } from './labels';
import { citationsOf, LANE_CAPTION } from './sources';
import { formatDateTime, pagesLabel, locationLabel, relativeTime } from './format';
import { authRedirect } from './navigation';
import type { MessageView } from '@itp/shared';

describe('permission mirror (backend/src/common/policy.ts)', () => {
  it('viewers can read machines but never create incidents', () => {
    expect(can('viewer', 'machine.read')).toBe(true);
    expect(can('viewer', 'incident.create')).toBe(false);
    expect(can('viewer', 'conversation.create')).toBe(false);
  });

  it('technicians can create incidents/actions and record fixes, but hold no confirm capabilities', () => {
    expect(can('technician', 'incident.create')).toBe(true);
    expect(can('technician', 'incident_action.create')).toBe(true);
    expect(can('technician', 'incident.fix_record')).toBe(true);
    expect(can('technician', 'incident.root_cause_confirm')).toBe(false);
    expect(can('technician', 'incident.close')).toBe(false);
  });

  it('managers can confirm and close; admins inherit everything', () => {
    expect(can('manager', 'incident.root_cause_confirm')).toBe(true);
    expect(can('manager', 'incident.close')).toBe(true);
    expect(can('manager', 'incident_action.confirm')).toBe(true);
    expect(can('admin', 'incident.delete')).toBe(true);
    expect(can('admin', 'machine.read')).toBe(true);
  });

  it('denies everything for missing roles (deny by default)', () => {
    expect(can(null, 'incident.read')).toBe(false);
    expect(capabilitiesOf(null)).toEqual([]);
  });

  it('confirmation affordances follow the service-adjudicated model', () => {
    // Technicians may attempt confirms - the service decides in `self` mode.
    expect(canAttempt('technician', 'confirmRootCause')).toBe(true);
    expect(canAttempt('technician', 'confirmAction')).toBe(true);
    // Viewers never.
    expect(canAttempt('viewer', 'confirmRootCause')).toBe(false);
    // Cancellation needs delete/update_any.
    expect(canAttempt('technician', 'cancelIncident')).toBe(false);
    expect(canAttempt('manager', 'cancelIncident')).toBe(true);
  });
});

describe('status labels (never colour alone)', () => {
  it('pairs icon + label + tone and falls back for unknown values', () => {
    const open = incidentStatus('open');
    expect(open.label).toBe('Open');
    expect(open.icon).not.toBe('');
    const unknown = incidentStatus('some_future_status');
    expect(unknown.tone).toBe('neutral');
    expect(unknown.label).toBe('some future status');
  });

  it('covers every workflow surface', () => {
    expect(severity('critical').label).toBe('Critical');
    expect(ragStatus('insufficient_evidence').label).toBe('Insufficient evidence');
    expect(syncOpStatus('requires_review').label).toBe('Needs review');
    expect(actionResultStatus('worsened_condition').label).toBe('Worsened');
    expect(outboxOpLabel.create_incident).toBe('Create incident');
    expect(incidentStatus(null).label).toBe('Unknown');
  });
});

describe('citation lanes', () => {
  const base = {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant' as const,
    messageType: 'answer' as const,
    content: '',
    originalQuery: null,
    normalizedQuery: null,
    status: 'completed' as const,
    sources: [],
    structuredResponse: null,
    retrievalMetadata: null,
    machineContext: null,
    suggestedActions: [],
    clarification: null,
    refusalReason: null,
    ragStatus: 'answered' as const,
    confidence: 'high' as const,
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('derives manual, historical and maintenance lanes from the structured response', () => {
    const message = {
      ...base,
      structuredResponse: {
        sources: [
          { sourceId: 'source-1', chunkId: 'chunk-1', manualId: 'man-1', manualTitle: 'Pump Manual', manualVersion: '2.1', pageStart: 40, pageEnd: 42, sourceType: 'manual' },
          { sourceId: 'history-1', chunkId: 'inc-9', manualId: '', manualTitle: 'INCIDENT INC-2025-9', sourceType: 'incident', incidentNumber: 'INC-2025-9' },
          { sourceId: 'maint-1', manualId: '', sourceType: 'maintenance', daysBeforeIncident: 12, correlationStrength: 'moderate', causalClaim: false },
        ],
      },
    } as unknown as MessageView;
    const citations = citationsOf(message);
    expect(citations.map((c) => c.lane)).toEqual(['manual', 'historical', 'maintenance']);
    expect(citations[0]?.manualId).toBe('man-1');
    expect(citations[1]?.incidentId).toBe('inc-9');
    expect(citations[1]?.incidentNumber).toBe('INC-2025-9');
    expect(citations[2]?.causalClaim).toBe(false);
    expect(citations[2]?.daysBeforeIncident).toBe(12);
  });

  it('falls back to message.sources as manual citations', () => {
    const message = {
      ...base,
      sources: [
        {
          sourceId: 'source-1',
          chunkId: 'ch1',
          manualId: 'man-1',
          manualTitle: 'Manual A',
          manualVersion: '1.0',
          pageStart: 3,
          pageEnd: 3,
          sectionTitle: 'Start-up',
          machineModelId: null,
          excerpt: 'Prime the pump',
        },
      ],
    } as unknown as MessageView;
    const citations = citationsOf(message);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.lane).toBe('manual');
    expect(citations[0]?.chunkId).toBe('ch1');
  });

  it('never returns citations for user messages', () => {
    const message = { ...base, role: 'user' as const } as MessageView;
    expect(citationsOf(message)).toEqual([]);
  });

  it('keeps the historical disclaimer wording explicit', () => {
    expect(LANE_CAPTION.historical).toContain('Historical context only');
    expect(LANE_CAPTION.historical).toContain('does not confirm');
    expect(LANE_CAPTION.maintenance).toContain('never causally linked');
  });
});

describe('formatting', () => {
  it('formats page ranges', () => {
    expect(pagesLabel(4, 4)).toBe('p. 4');
    expect(pagesLabel(4, 6)).toBe('pp. 4–6');
    expect(pagesLabel(0, 0)).toBe('');
  });

  it('formats locations', () => {
    expect(locationLabel({ site: 'Plant 1', area: 'Line 3', position: 'North' })).toBe('Plant 1 · Line 3 · North');
    expect(locationLabel(null)).toBe('');
  });

  it('formats relative time', () => {
    const now = new Date('2026-09-04T12:00:00Z').getTime();
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe('just now');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 h ago');
    expect(relativeTime(null, now)).toBe('never');
  });

  it('formats dates readably and tolerates junk', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('auth-redirect guard', () => {
  it('sends unauthenticated users to login from anywhere protected', () => {
    expect(authRedirect('/(app)/(tabs)/home', 'unauthenticated')).toBe('/login');
    expect(authRedirect('/(app)/incidents/abc', 'unauthenticated')).toBe('/login');
  });

  it('keeps unauthenticated users on auth screens', () => {
    expect(authRedirect('/login', 'unauthenticated')).toBeNull();
    expect(authRedirect('/forgot-password', 'unauthenticated')).toBeNull();
  });

  it('bounces authenticated users off the login screen', () => {
    expect(authRedirect('/login', 'authenticated')).toBe('/(app)/(tabs)/home');
  });

  it('never redirects while loading', () => {
    expect(authRedirect('/(app)/(tabs)/home', 'loading')).toBeNull();
    expect(authRedirect('/login', 'loading')).toBeNull();
  });

  it('leaves authenticated users on protected screens', () => {
    expect(authRedirect('/(app)/(tabs)/work', 'authenticated')).toBeNull();
  });
});
