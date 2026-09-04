/**
 * Settings: account profile (display name) and password change.
 *
 * Both call existing endpoints (PATCH /users/me, POST /auth/change-password).
 * There is no organization-management endpoint in this phase, so org context
 * is displayed read-only.
 */
import { FormEvent, useState } from 'react';
import { apiClient, ApiClientError } from '../lib/api-client';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { formatDate } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  Field,
  PageHeader,
  PasswordInput,
  TextInput,
} from '../components/ui';
import { rolePresentation } from '../lib/user-labels';
import './page.css';

export function SettingsPage(): JSX.Element {
  const { user, updateUser } = useAuth();
  const toast = useToast();

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [savingPassword, setSavingPassword] = useState(false);

  async function saveName(event: FormEvent): Promise<void> {
    event.preventDefault();
    setNameError(null);
    if (!fullName.trim()) {
      setNameError('Full name cannot be empty.');
      return;
    }
    setSavingName(true);
    try {
      const { user: updated } = await apiClient.updateMe({ fullName: fullName.trim() });
      updateUser(updated);
      toast.success('Profile updated.');
    } catch (caught) {
      toast.error(caught instanceof ApiClientError ? caught.message : 'Could not update profile.');
    } finally {
      setSavingName(false);
    }
  }

  function validatePasswords(): boolean {
    const next: Record<string, string> = {};
    if (!passwords.current) next.current = 'Your current password is required.';
    if (!passwords.next) next.next = 'A new password is required.';
    else if (passwords.next.length < 12) next.next = 'New password must be at least 12 characters.';
    else if (passwords.next === passwords.current) next.next = 'The new password must be different.';
    if (passwords.confirm !== passwords.next) next.confirm = 'Passwords do not match.';
    setPasswordErrors(next);
    return Object.keys(next).length === 0;
  }

  async function changePassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!validatePasswords()) return;
    setSavingPassword(true);
    try {
      await apiClient.changePassword(passwords.current, passwords.next);
      toast.success('Password changed. Use it at your next sign-in.');
      setPasswords({ current: '', next: '', confirm: '' });
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status !== 401) {
        toast.error(caught.message);
      } else if (caught instanceof ApiClientError) {
        setPasswordErrors({ current: caught.message });
      } else {
        toast.error('Could not change password.');
      }
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description="Your account and profile. Permissions are assigned per role by administrators."
        breadcrumbs={[{ label: 'Settings' }]}
      />

      {user && (
        <Card>
          <div className="section-head">
            <h2>Account</h2>
            <Badge presentation={rolePresentation(user.role)} size="sm" />
          </div>
          <DescriptionList
            items={[
              { label: 'Full name', value: user.fullName },
              { label: 'Username', value: user.username },
              { label: 'Email', value: user.email },
              { label: 'Account created', value: formatDate(user.createdAt, false) },
              { label: 'Last login', value: formatDate(user.lastLoginAt) },
              { label: 'Organization', value: 'Your organization (single-organization deployment)' },
            ]}
          />
        </Card>
      )}

      <Card>
        <div className="section-head"><h2>Profile</h2></div>
        <form className="ui-form" onSubmit={saveName} noValidate style={{ maxWidth: 480 }}>
          <Field label="Full name" htmlFor="settings-fullName" required error={nameError ?? undefined}>
            <TextInput
              id="settings-fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={savingName}>Save profile</Button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="section-head"><h2>Change password</h2></div>
        <Alert tone="warn">
          After changing your password you will keep your current session; use the new password
          next time you sign in.
        </Alert>
        <form className="ui-form" onSubmit={changePassword} noValidate style={{ maxWidth: 480 }}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <Field label="Current password" htmlFor="pw-current" required error={passwordErrors.current}>
              <PasswordInput
                id="pw-current"
                value={passwords.current}
                onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
                autoComplete="current-password"
              />
            </Field>
            <Field
              label="New password"
              htmlFor="pw-next"
              required
              error={passwordErrors.next}
              hint="At least 12 characters. Use a unique passphrase."
            >
              <PasswordInput
                id="pw-next"
                value={passwords.next}
                onChange={(e) => setPasswords((p) => ({ ...p, next: e.target.value }))}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password" htmlFor="pw-confirm" required error={passwordErrors.confirm}>
              <PasswordInput
                id="pw-confirm"
                value={passwords.confirm}
                onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={savingPassword}>Change password</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
