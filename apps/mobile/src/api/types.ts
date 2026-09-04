/**
 * Wire types for endpoints whose views live in backend services (not in
 * @itp/shared). Shapes mirror the `toView()` projections exactly:
 *   - MachineView        → backend/src/modules/machines/machines.service.ts
 *   - MachineModelView   → backend/src/modules/machine-models/machine-models.service.ts
 *   - ManualView         → backend/src/modules/manuals/manuals.service.ts
 * Everything else (incidents, actions, conversations, messages, users, RAG)
 * reuses @itp/shared contracts directly.
 */
import type {
  Criticality,
  DocumentType,
  IssueStatus,
  MachineStatus,
  MachineType,
  ManualScope,
  ProcessingStatus,
} from '@itp/shared';

export interface MachineView {
  id: string;
  assetTag: string;
  machineModelId: string;
  modelSnapshot: { manufacturer: string; modelName: string; machineType: string } | null;
  displayName: string | null;
  serialNumber: string | null;
  location: { site?: string; area?: string; line?: string; position?: string } | null;
  status: MachineStatus;
  installedAt: string | null;
  commissionedAt: string | null;
  criticality: Criticality | null;
  notes: string | null;
  lastMaintenanceAt: string | null;
  openIncidentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MachineModelView {
  id: string;
  manufacturer: string;
  modelName: string;
  machineType: MachineType;
  aliases: string[];
  modelYear: number | null;
  specifications: Record<string, unknown> | null;
  defaultLanguage: string;
  notes: string | null;
  machineCount: number;
  manualCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManualView {
  id: string;
  title: string;
  description: string | null;
  manufacturer: string | null;
  scope: ManualScope;
  machineModelId: string | null;
  machineId: string | null;
  documentType: DocumentType;
  documentNumber: string | null;
  documentVersion: string | null;
  revision: string | null;
  isCurrentVersion: boolean;
  isActive: boolean;
  language: string;
  originalFilename: string;
  fileSizeBytes: number;
  sha256: string;
  mimeType: string;
  pageCount: number | null;
  processingStatus: ProcessingStatus;
  processingVersion: string | null;
  extractionMethod: string | null;
  ocrUsed: boolean;
  indexedChunkCount: number;
  indexedAt: string | null;
  processedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  isSearchable: boolean;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Conversation summary as rendered in lists (superset of ConversationView). */
export interface ConversationListItem {
  id: string;
  title: string | null;
  createdBy: string;
  machineId: string | null;
  machineModelId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  machineLabel: string | null;
  machineModelLabel: string | null;
  manualTitle: string | null;
  status: string;
  issueStatus: IssueStatus;
  issueSummary: string | null;
  errorCodes: string[];
  symptoms: string[];
  lastMessageAt: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /conversations/:id/messages response. */
export interface PostMessageResponse {
  message: import('@itp/shared').MessageView;
  userMessage: import('@itp/shared').MessageView;
  rag: {
    status: import('@itp/shared').RagStatus;
    confidence: string | null;
    evidenceSufficient: boolean;
    sources: import('@itp/shared').RagSourceView[];
    warnings: string[];
    clarification: string | null;
    refusalReason: string | null;
  };
  conversation: {
    id: string;
    issueStatus: IssueStatus;
    status: string;
    messageCount: number;
  };
}
