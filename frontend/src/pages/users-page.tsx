/**
 * User management.
 *
 * Managers/admins see the user list; only admins may create accounts (the
 * `/auth/register` endpoint honours a role only when the caller is an admin;
 * self-registration always creates a viewer). There is NO role-update or
 * delete-user endpoint in this phase — documented as a missing contract in
 * FRONTEND_API_INTEGRATION.md rather than faked.
 */
import { FormEvent, useMemo, useState } from 'react';
import { USER_ROLES } from '@itp/shared';
import { apiClient, ApiClientError, type UserRecord } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { formatDate } from '../lib/format';
import { roleLabel } from '../lib/permissions';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  PasswordInput,
  SelectInput,
  SkeletonTable,
  TextInput,
} from '../components/ui';
import { ErrorState } from '../components/states';
import { rolePresentation } from '../lib/user-labels';
import './page.css';

export function UsersPage(): JSX.Element {
  const { can } = useAuth();
  const toast = useToast();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);

  const { data, error, isLoading, refetch } = useApi<UserRecord[]>(
    () => apiClient.listUsers().then((r) => r.users),
    [],
  );

  const users = useMemo(() => data ?? [], [data]);
  const filtered = useMemo(
    () =>
      users.filter((u) => {
        if (!search) return true;
        const needle = search.toLowerCase();
        return (
          u.username.toLowerCase().includes(needle) ||
          u.fullName.toLowerCase().includes(needle) ||
          u.email.toLowerCase().includes(needle)
        );
      }),
    [users, search],
  );

  // Create-user modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    username: '',
    email: '',
    fullName: '',
    password: '',
    role: 'technician',
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.username.trim()) next.username = 'Username is required.';
    else if (!/^[a-zA-Z0-9_.-]{3,}$/.test(form.username.trim()))
      next.username = 'At least 3 characters: letters, numbers, dot, dash, underscore.';
    if (!form.email.trim()) next.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      next.email = 'Enter a valid email address.';
    if (!form.fullName.trim()) next.fullName = 'Full name is required.';
    if (!form.password) next.password = 'A temporary password is required.';
    else if (form.password.length < 12) next.password = 'Password must be at least 12 characters.';
    setFormErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      await apiClient.registerUser({
        username: form.username.trim(),
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        password: form.password,
        role: form.role as (typeof USER_ROLES)[number],
      });
      toast.success(`User ${form.username} created.`);
      setCreateOpen(false);
      setForm({ username: '', email: '', fullName: '', password: '', role: 'technician' });
      refetch();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.details?.length) {
        const fieldErrors: Record<string, string> = {};
        for (const detail of caught.details) {
          fieldErrors[detail.field.split('.').pop() ?? detail.field] = detail.issue;
        }
        setFormErrors(fieldErrors);
      } else if (caught instanceof ApiClientError) {
        toast.error(caught.message);
      } else {
        toast.error('Could not create the user.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Users"
        description="Accounts in your organization. Roles determine what each user can see and do; the backend enforces every permission."
        breadcrumbs={[{ label: 'Users' }]}
        actions={
          can('user.create') ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              New user
            </Button>
          ) : null
        }
      />

      <Card>
        <form className="filter-bar" role="search" onSubmit={(e) => e.preventDefault()}>
          <div className="field field--search">
            <label className="field__label" htmlFor="user-search">Search</label>
            <TextInput
              id="user-search"
              type="search"
              placeholder="Name, username or email…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </form>

        {isLoading && <SkeletonTable rows={6} cols={5} />}
        {!isLoading && error && <ErrorState error={error} onRetry={refetch} title="Could not load users" />}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState title="No users found" message="Try a different search." icon="👤" />
        )}

        {!isLoading && !error && filtered.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.id}>
                    <td>{user.fullName}</td>
                    <td className="mono">{user.username}</td>
                    <td>{user.email}</td>
                    <td><Badge presentation={rolePresentation(user.role)} size="sm" /></td>
                    <td>
                      {user.isActive ? (
                        <Badge presentation={{ tone: 'ok', icon: '●', label: 'Active' }} size="sm" />
                      ) : (
                        <Badge presentation={{ tone: 'neutral', icon: '○', label: 'Disabled' }} size="sm" />
                      )}
                      {user.mustChangePassword && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: '0.75rem' }}>
                          must change password
                        </span>
                      )}
                    </td>
                    <td>{formatDate(user.lastLoginAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create user"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" form="user-form" loading={saving}>Create user</Button>
          </>
        }
      >
        <form id="user-form" className="ui-form" onSubmit={onSubmit} noValidate>
          <Alert tone="info">
            The new account gets the role you select. Share the temporary password through a
            secure channel — the user should change it after first sign-in.
          </Alert>
          <div className="form-grid">
            <Field label="Full name" htmlFor="user-fullName" required error={formErrors.fullName}>
              <TextInput id="user-fullName" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} autoFocus />
            </Field>
            <Field label="Username" htmlFor="user-username" required error={formErrors.username}>
              <TextInput id="user-username" value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Email" htmlFor="user-email" required error={formErrors.email}>
              <TextInput id="user-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
            <Field label="Role" htmlFor="user-role" required>
              <SelectInput id="user-role" value={form.role} onChange={(e) => set('role', e.target.value)}>
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>{roleLabel(role)}</option>
                ))}
              </SelectInput>
            </Field>
            <Field
              label="Temporary password"
              htmlFor="user-password"
              required
              error={formErrors.password}
              hint="At least 12 characters."
              className="field--full"
            >
              <PasswordInput id="user-password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        </form>
      </Modal>
    </div>
  );
}
