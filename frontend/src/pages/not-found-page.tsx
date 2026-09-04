import { Link } from 'react-router-dom';
import { EmptyState } from '../components/states';
import './page.css';

export function NotFoundPage(): JSX.Element {
  return (
    <div className="page">
      <EmptyState
        icon="404"
        title="Page not found"
        message="This route does not exist. It may belong to a feature that has not been built yet."
        action={<Link to="/">Return home</Link>}
      />
    </div>
  );
}
