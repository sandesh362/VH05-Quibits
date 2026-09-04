import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiClientError } from '../lib/api-client';
import './page.css';
import './chat.css';

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/conversations');
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Sign-in failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>Sign in</h1>
        <p className="page__lead">Technicians sign in to start or continue a troubleshooting conversation.</p>
      </header>
      <form className="card form" onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="page__note">
          There are no default credentials. Create an administrator with <code>npm run create-admin</code>.
        </p>
        <p className="page__note">
          <Link to="/">Back home</Link>
        </p>
      </form>
    </div>
  );
}
