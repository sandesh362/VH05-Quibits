/**
 * Troubleshooting module — Zod validators.
 *
 * Defines the request/response wire format for the mobile → Express → FastAPI
 * troubleshooting query chain. Phase 1 returns hardcoded responses from
 * FastAPI; Phase 2+ plugs in real RAG retrieval.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const queryBodySchema = z.object({
  machine_id: z.string().min(1, 'machine_id is required').optional(),
  machine_model_id: z.string().min(1).optional(),
  query: z
    .string()
    .min(1, 'Query must not be empty')
    .max(2000, 'Query must be at most 2000 characters'),
  conversation_id: z.string().optional(),
  options: z
    .object({
      include_history: z.boolean().default(true),
      include_maintenance: z.boolean().default(true),
      cross_model_history: z.boolean().default(false),
      debug: z.boolean().default(false),
    })
    .default({}),
});

export type QueryBody = z.infer<typeof queryBodySchema>;

// ---------------------------------------------------------------------------
// Response (from FastAPI — typed here for documentation, not validated inbound)
// ---------------------------------------------------------------------------

export interface ProbableCause {
  cause: string;
  probability: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface CorrectiveStep {
  step: number;
  action: string;
  safety_critical?: boolean;
}

export interface SourceReference {
  manual_title: string;
  section: string;
  page: number;
  relevance: number;
}

export interface TroubleshootResponse {
  diagnosis: string;
  answer_status: 'answered' | 'clarification_required' | 'insufficient_evidence' | 'generation_unavailable';
  confidence: number;
  probable_causes: ProbableCause[];
  corrective_steps: CorrectiveStep[];
  warnings: string[];
  sources: SourceReference[];
}
