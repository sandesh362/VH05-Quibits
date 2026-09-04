/**
 * Vitest setup for the frontend.
 * Registers jest-dom matchers and resets mocks between tests.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
