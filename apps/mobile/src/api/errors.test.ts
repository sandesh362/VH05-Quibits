import { ApiError, errorMessage } from './errors';

describe('error message normalization', () => {
  it('gives human copy for network errors without internals', () => {
    const message = errorMessage(new ApiError('NETWORK_ERROR', 'Cannot reach the API.'));
    expect(message).toContain('Cannot reach the server');
    expect(message).not.toContain('ApiError');
  });

  it('gives human copy for timeouts', () => {
    expect(errorMessage(new ApiError('TIMEOUT', 't'))).toContain('took too long');
  });

  it('explains expired sessions', () => {
    expect(errorMessage(new ApiError('UNAUTHENTICATED', 'x'))).toContain('session has expired');
  });

  it('explains forbidden actions', () => {
    expect(errorMessage(new ApiError('FORBIDDEN', 'x'))).toContain('not allowed');
  });

  it('explains missing records without leaking ids', () => {
    const message = errorMessage(new ApiError('NOT_FOUND', 'Incident 123 not found.', 404));
    expect(message).toContain('no longer');
  });

  it('passes through server validation copy', () => {
    const message = errorMessage(new ApiError('VALIDATION_ERROR', 'Title must be at least 3 characters.', 422));
    expect(message).toBe('Title must be at least 3 characters.');
  });

  it('never exposes stack traces', () => {
    const message = errorMessage(new Error('at Object.<anonymous> (src/foo.ts:1:1)'));
    expect(message).not.toContain('src/foo.ts');
  });
});
