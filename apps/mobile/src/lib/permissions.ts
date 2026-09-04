/**
 * Role → capability mirror of backend/src/common/policy.ts.
 *
 * The API remains the final authority; this map only hides UI the user cannot
 * possibly use. Two levels exist:
 *
 *  - `can`            — the route-level capability is in the role's policy set.
 *  - `canAttempt`     — the route lets the role through and the SERVICE decides
 *                       by ownership + INCIDENT_CONFIRMATION_MODE (technicians
 *                       may confirm their own work in `self` mode). We show the
 *                       affordance for technician+ and surface a readable
 *                       403 message when the server declines.
 */
import type { Capability, UserRole } from '@itp/shared';

const READ_ONLY: Capability[] = [
  'machine_model.read',
  'machine.read',
  'manual.read',
  'manual_processing_job.read',
  'manual_page.read',
  'manual_chunk.read',
  'incident.read',
  'incident_action.read',
  'maintenance.read',
  'user.read_self',
  'user.update_self',
];

const TECHNICIAN: Capability[] = [
  ...READ_ONLY,
  'incident.create',
  'incident.update_own',
  'incident.root_cause_update',
  'incident.fix_record',
  'incident_action.create',
  'incident_action.update',
  'maintenance.create',
  'maintenance.update_own',
  'conversation.create',
  'conversation.read_own',
  'conversation.update_own',
];

const MANAGER: Capability[] = [
  ...TECHNICIAN,
  'machine_model.create',
  'machine_model.update',
  'machine.create',
  'machine.update',
  'manual.create',
  'manual.update',
  'manual.delete',
  'manual.reprocess',
  'incident.update_any',
  'incident.assign',
  'incident.root_cause_confirm',
  'incident.root_cause_reject',
  'incident.fix_confirm',
  'incident_action.confirm',
  'incident.close',
  'incident.reopen',
  'incident.reindex',
  'maintenance.update_any',
  'conversation.read_any',
  'user.read_all',
  'audit_log.read',
];

const ADMIN: Capability[] = [
  ...MANAGER,
  'machine_model.delete',
  'machine.delete',
  'incident.delete',
  'user.create',
  'user.update_role',
];

const POLICY: Record<UserRole, Capability[]> = {
  viewer: READ_ONLY,
  technician: TECHNICIAN,
  manager: MANAGER,
  admin: ADMIN,
};

export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return POLICY[role]?.includes(capability) ?? false;
}

/** Capabilities a role holds, for the profile screen summary. */
export function capabilitiesOf(role: UserRole | null | undefined): Capability[] {
  if (!role) return [];
  return [...(POLICY[role] ?? [])];
}

/**
 * Server-adjudicated affordances: shown to any role whose request the service
 * *might* accept (viewer can never - its policy set contains nothing that the
 * confirmation services would accept).
 */
export type Attempt =
  | 'confirmRootCause'
  | 'rejectRootCause'
  | 'confirmTemporaryFix'
  | 'confirmPermanentFix'
  | 'confirmAction'
  | 'closeIncident'
  | 'reopenIncident'
  | 'cancelIncident';

export function canAttempt(role: UserRole | null | undefined, attempt: Attempt): boolean {
  if (!role || role === 'viewer') return false;
  switch (attempt) {
    case 'cancelIncident':
      // DELETE /incidents/:id requires incident.delete or update_any.
      return can(role, 'incident.delete') || can(role, 'incident.update_any');
    default:
      return true;
  }
}
