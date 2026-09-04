/**
 * Form validation mirrors of the backend validators.
 */
import {
  loginSchema,
  createIncidentSchema,
  recordActionSchema,
  fixRecordSchema,
  closeSchema,
  messageSchema,
} from './schemas';

describe('login schema', () => {
  it('requires a valid email and a password', () => {
    expect(loginSchema.safeParse({ email: 'tech@example.com', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'tech@example.com', password: '' }).success).toBe(false);
  });
});

describe('incident creation schema (mirrors createIncidentSchema)', () => {
  const valid = {
    title: 'Pump 3 vibrating',
    description: 'Loud grinding noise from the drive end during high load.',
    machineId: 'machine-1',
    severity: 'high' as const,
    priority: 'medium' as const,
    symptoms: ['grinding noise'],
    errorCodes: [],
    operatingConditions: [],
    tags: [],
  };

  it('accepts a complete field report', () => {
    expect(createIncidentSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the machine and a description of sensible length', () => {
    expect(createIncidentSchema.safeParse({ ...valid, machineId: '' }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...valid, description: 'ab' }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...valid, title: 'ab' }).success).toBe(false);
  });

  it('bounds list fields like the backend (50 symptoms max)', () => {
    const symptoms = Array.from({ length: 51 }, (_, i) => `s${i}`);
    expect(createIncidentSchema.safeParse({ ...valid, symptoms }).success).toBe(false);
  });

  it('defaults are explicit, not silently invented', () => {
    const parsed = createIncidentSchema.parse(valid);
    expect(parsed.severity).toBe('high');
  });
});

describe('technician action schema (mirrors createActionSchema rule)', () => {
  it('only technician actions may record an observed result', () => {
    const technician = {
      actionType: 'technician' as const,
      description: 'Cleaned strainer',
      resultStatus: 'successful' as const,
    };
    const suggestion = {
      actionType: 'assistant_suggestion' as const,
      description: 'Check strainer',
      resultStatus: 'successful' as const,
    };
    expect(recordActionSchema.safeParse(technician).success).toBe(true);
    expect(recordActionSchema.safeParse(suggestion).success).toBe(false);
  });

  it('requires a description of at least 3 characters', () => {
    expect(
      recordActionSchema.safeParse({ actionType: 'technician', description: 'ab', resultStatus: 'not_tested' }).success,
    ).toBe(false);
  });

  it('accepts every backend result status for technician actions', () => {
    for (const resultStatus of [
      'not_tested',
      'successful',
      'unsuccessful',
      'partially_successful',
      'inconclusive',
      'temporary_improvement',
      'worsened_condition',
    ] as const) {
      expect(
        recordActionSchema.safeParse({ actionType: 'technician', description: 'did a thing', resultStatus }).success,
      ).toBe(true);
    }
  });
});

describe('other form schemas', () => {
  it('fix records need a description', () => {
    expect(fixRecordSchema.safeParse({ description: 'Replaced drive belt' }).success).toBe(true);
    expect(fixRecordSchema.safeParse({ description: 'ab' }).success).toBe(false);
  });

  it('closing requires a resolution summary', () => {
    expect(closeSchema.safeParse({ resolutionSummary: 'Replaced bearing; verified run-out.' }).success).toBe(true);
    expect(closeSchema.safeParse({ resolutionSummary: 'ok' }).success).toBe(false);
  });

  it('messages must be present and bounded', () => {
    expect(messageSchema.safeParse({ content: 'Why does E-104 appear at startup?' }).success).toBe(true);
    expect(messageSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(messageSchema.safeParse({ content: 'x'.repeat(5001) }).success).toBe(false);
  });
});
