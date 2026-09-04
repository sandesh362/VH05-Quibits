/**
 * Authorization policy: a single map from (role -> capabilities).
 *
 * Phase 0 (PRODUCT_REQUIREMENTS.md 13.1) called for exactly this shape rather
 * than `if (role === 'admin')` scattered through handlers. Everything about who
 * can do what is visible on one screen and testable as data.
 *
 * DENY BY DEFAULT: a capability absent from a role's set is denied. A route
 * that declares no capability is unreachable rather than public.
 */
import type { Capability, UserRole } from '@itp/shared';

/** Read capabilities shared by every authenticated role, including viewer. */
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

/** Technicians do the work: they create incidents, actions, maintenance. */
const TECHNICIAN: Capability[] = [
  ...READ_ONLY,
  'incident.create',
  'incident.update_own',
  /**
   * Technicians may update root-cause text/status to `suspected`, record
   * fixes, and record actions. Confirmation of outcomes, fixes, root causes
   * and closure is resolved in the service by ownership + policy - the route
   * lets technicians through and the service makes the real decision, exactly
   * like the Phase 5 resolution flow.
   */
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

/** Managers own data quality across the fleet. */
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

/** Admin additionally manages users and may delete structural records. */
const ADMIN: Capability[] = [
  ...MANAGER,
  'machine_model.delete',
  'machine.delete',
  'incident.delete',
  'user.create',
  'user.update_role',
];

/**
 * The authoritative matrix. Frozen sets so a bug cannot mutate policy at
 * runtime.
 */
export const ROLE_CAPABILITIES: Readonly<Record<UserRole, ReadonlySet<Capability>>> = Object.freeze(
  {
    admin: new Set(ADMIN),
    manager: new Set(MANAGER),
    technician: new Set(TECHNICIAN),
    viewer: new Set(READ_ONLY),
  },
);

export function roleHasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

/** Flat list for `/system/info` and tests. */
export function capabilitiesForRole(role: UserRole): Capability[] {
  return [...(ROLE_CAPABILITIES[role] ?? [])].sort();
}

/**
 * Who may set `resolution_confirmed`.
 *
 * `self`       - the reporter/assignee who worked the incident, or a manager.
 * `supervisor` - manager/admin only.
 *
 * Phase 0 13.4 left this open and recommended making it configurable; the
 * decision is deferred to deployment rather than baked into code.
 */
export function canConfirmResolution(
  mode: 'self' | 'supervisor',
  role: UserRole,
  isOwnIncident: boolean,
): boolean {
  if (role === 'admin' || role === 'manager') return true;
  if (mode === 'self' && role === 'technician') return isOwnIncident;
  return false;
}
