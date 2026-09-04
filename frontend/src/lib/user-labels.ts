import type { StatusPresentation } from './labels';

/** Role presentation for badges. */
export function rolePresentation(role: string): StatusPresentation {
  switch (role) {
    case 'admin':
      return { tone: 'error', icon: '✦', label: 'Administrator' };
    case 'manager':
      return { tone: 'info', icon: '◆', label: 'Maintenance manager' };
    case 'technician':
      return { tone: 'ok', icon: '⚒', label: 'Technician' };
    case 'viewer':
      return { tone: 'neutral', icon: '○', label: 'Viewer' };
    default:
      return { tone: 'neutral', icon: '·', label: role };
  }
}
