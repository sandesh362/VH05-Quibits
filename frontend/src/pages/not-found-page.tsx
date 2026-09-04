import { Link } from 'react-router-dom';
import { Button } from '../components/ui';
import './page.css';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="status-page">
      <span className="status-page__icon" aria-hidden="true">
        🔍
      </span>
      <h1>Page not found</h1>
      <p className="page__lead">
        The page you are looking for does not exist or may have been moved.
      </p>
      <Link to="/dashboard">
        <Button variant="primary">Back to dashboard</Button>
      </Link>
    </div>
  );
}
