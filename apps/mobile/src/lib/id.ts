import * as Crypto from 'expo-crypto';

/**
 * Collision-resistant id used for outbox operations and idempotency keys.
 * `expo-crypto` is part of Expo Go - no custom native code.
 */
export function newId(): string {
  return Crypto.randomUUID();
}
