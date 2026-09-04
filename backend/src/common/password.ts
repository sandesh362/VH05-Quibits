/**
 * Password hashing and strength policy.
 *
 * Argon2id, per docs/DATA_MODEL.md 1 and SECURITY_AND_RELIABILITY.md. It is the
 * current OWASP recommendation and resists GPU cracking far better than bcrypt.
 * `@node-rs/argon2` ships prebuilt binaries, so there is no compiler dependency
 * during install.
 */
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';

/**
 * OWASP "second choice" parameters (19 MiB, t=2, p=1). Chosen over the heavier
 * profile because the target hardware is a laptop that is also running Ollama;
 * memory pressure during a demo is a real failure mode.
 */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/** Rejected outright regardless of length. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'letmein123', 'welcome123', 'admin12345', 'iloveyou1',
  'changeme123', 'maintenance', 'industrial',
]);

export interface PasswordCheck {
  valid: boolean;
  issues: string[];
}

/**
 * Composition policy.
 *
 * Length is weighted over character-class gymnastics: NIST SP 800-63B found
 * forced complexity produces predictable substitutions (`P@ssw0rd!`) without
 * meaningful entropy gain. We require length, a mix of letters and non-letters,
 * and screen against a common-password list.
 */
export function validatePasswordStrength(password: string): PasswordCheck {
  const issues: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (!/[a-zA-Z]/.test(password)) {
    issues.push('Password must contain at least one letter.');
  }
  if (!/[^a-zA-Z]/.test(password)) {
    issues.push('Password must contain at least one number or symbol.');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    issues.push('That password is too common. Choose something less predictable.');
  }
  if (/^(.)\1+$/.test(password)) {
    issues.push('Password must not be a single repeated character.');
  }

  return { valid: issues.length === 0, issues };
}

export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored
 * hash, so a corrupted record cannot turn a login into a 500.
 */
export async function verifyPassword(hashString: string, plaintext: string): Promise<boolean> {
  try {
    return await argonVerify(hashString, plaintext);
  } catch {
    return false;
  }
}

/**
 * Argon2 hash of a throwaway value, used to equalise timing on the
 * "user not found" path so login cannot be used to enumerate accounts.
 * Computed once at module load.
 */
let dummyHashPromise: Promise<string> | null = null;

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argonHash('itp-timing-equaliser-not-a-real-password', ARGON_OPTIONS);
  return dummyHashPromise;
}
