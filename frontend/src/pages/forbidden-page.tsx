/**
 * 403 Forbidden page.
 *
 * Shown when an authenticated user lacks the capability a route requires.
 * The API enforces the same rule; this is the clear, non-broken fallback.
 */
import { Link } from 'react-router-dom';
import { Button } from '../components/ui';
import './page.css';

export function ForbiddenPage(): JSX.Element {
  return (
    <div className="status-page status-page--warn" role="alert">
      <span className="status-page__icon" aria-hidden="true">
        ⛔
      </span>
      <h1>You do not have access to this page</h1>
      <p className="page__lead">
        Your account role does not include the permission required for this area. If you believe
        this is a mistake, ask an administrator to review your role.
      </p>
      <div className="form-actions" style={{ justifyContent: 'center' }}>
        <Link to="/dashboard">
          <Button variant="primary">Back to dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
