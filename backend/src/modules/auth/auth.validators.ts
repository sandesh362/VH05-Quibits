/**
 * Request schemas for the auth module.
 *
 * `.strict()` everywhere: an unknown key is an error, not something to ignore.
 * That catches typos and blocks mass-assignment attempts such as sending
 * `{"role":"admin","token_version":99}` to /auth/register.
 */
import { z } from 'zod';
import { USER_ROLES } from '@itp/shared';
import { boundedText, emailSchema, usernameSchema } from '../../common/validation.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../common/password.js';

/**
 * Password is length-checked here and strength-checked in the service.
 * Splitting the two keeps the detailed policy in one place while still
 * rejecting absurd input before it reaches Argon2.
 */
const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

export const registerSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema,
    password: passwordField,
    fullName: boundedText(1, 100, 'Full name'),
    /**
     * Accepted but IGNORED for self-registration; honoured only when an admin
     * is the caller. The service enforces that - never the client.
     */
    role: z.enum(USER_ROLES).optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    // No strength rules on login: the stored password predates any policy
    // change, and rejecting it here would lock out valid users.
    password: z.string().min(1, 'Password is required.').max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(1, 'A refresh token is required.').max(512),
  })
  .strict();

export const logoutSchema = z
  .object({
    refreshToken: z.string().max(512).optional(),
    allDevices: z.boolean().optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Your current password is required.').max(PASSWORD_MAX_LENGTH),
    newPassword: passwordField,
  })
  .strict()
  .refine((data) => data.currentPassword !== data.newPassword, {
    path: ['newPassword'],
    message: 'The new password must be different from the current one.',
  });

/** Self-service profile edits. Role and status are deliberately absent. */
export const updateMeSchema = z
  .object({
    fullName: boundedText(1, 100, 'Full name').optional(),
    preferences: z
      .object({
        locale: z.string().max(35).optional(),
        theme: z.enum(['light', 'dark', 'system']).optional(),
        timezone: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });
