/**
 * Frontend capability map.
 *
 * This MIRRORS backend/src/common/policy.ts and is used only to hide navigation
 * entries and disable buttons the API would reject. The Express policy remains
 * the source of truth: hiding a control never authorises an action, and a
 * 403 from the API is still handled by the Forbidden page / error states.
 */
import type { Capability, PublicUser, UserRole } from '@itp/shared';

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

const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  admin: ADMIN,
  manager: MANAGER,
  technician: TECHNICIAN,
  viewer: READ_ONLY,
};

export function can(user: PublicUser | null | undefined, capability: Capability): boolean {
  if (!user) return false;
  return (ROLE_CAPABILITIES[user.role] ?? []).includes(capability);
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'admin':
      return 'Administrator';
    case 'manager':
      return 'Maintenance manager';
    case 'technician':
      return 'Technician';
    case 'viewer':
      return 'Viewer';
    default:
      return role;
  }
}
