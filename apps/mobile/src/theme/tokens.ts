/**
 * Design tokens.
 *
 * Mirrors the web design system (frontend/src/styles/global.css): dark-first,
 * high contrast, for technicians on a shop floor. Status is never conveyed by
 * colour alone - every badge pairs colour with an icon and a text label
 * (frontend/src/lib/labels.ts convention).
 */
export const colors = {
  bg: '#0f1115',
  surface: '#171a21',
  surfaceRaised: '#1e222b',
  border: '#2a2f3a',
  borderStrong: '#3a4150',

  text: '#e6e9ef',
  textMuted: '#9aa3b2',
  textSubtle: '#6b7484',

  ok: '#3fb950',
  okBg: 'rgba(63, 185, 80, 0.14)',
  warn: '#d29922',
  warnBg: 'rgba(210, 153, 34, 0.14)',
  error: '#f85149',
  errorBg: 'rgba(248, 81, 73, 0.14)',
  info: '#58a6ff',
  infoBg: 'rgba(88, 166, 255, 0.14)',
  neutral: '#8b94a5',
  neutralBg: 'rgba(107, 116, 132, 0.16)',

  // Accent for primary actions.
  primary: '#4493f8',
  primaryBg: 'rgba(68, 147, 248, 0.16)',
  onPrimary: '#0b1220',
} as const;

export const toneColor = {
  ok: colors.ok,
  info: colors.info,
  warn: colors.warn,
  error: colors.error,
  neutral: colors.neutral,
} as const;

export const toneBg = {
  ok: colors.okBg,
  info: colors.infoBg,
  warn: colors.warnBg,
  error: colors.errorBg,
  neutral: colors.neutralBg,
} as const;

export type Tone = keyof typeof toneColor;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

/**
 * Field-readable typography. Deliberately larger than typical mobile defaults:
 * used with gloves, in bad light, next to a machine.
 */
export const type = {
  title: 24,
  heading: 20,
  subheading: 17,
  body: 16,
  small: 14,
  tiny: 12,
} as const;

/** Minimum comfortable touch target (pt). */
export const minTouchTarget = 48;
