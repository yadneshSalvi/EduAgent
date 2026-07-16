import { dark } from '@clerk/themes';
import type { NextClerkProviderProps } from '@clerk/nextjs/types';

type Appearance = NextClerkProviderProps['appearance'];

/**
 * Clerk components themed to the EduAgent tokens (plans/04 §2: "dark, violet
 * accent — an off-brand default Clerk modal would break the design bar").
 * Values mirror the dark palette in globals.css; Clerk renders in an isolated
 * scope, so raw values are used instead of CSS variables.
 */
export const clerkAppearance: Appearance = {
  theme: dark,
  variables: {
    colorPrimary: '#7c6aef',
    colorPrimaryForeground: '#ffffff',
    colorBackground: '#12151d',
    colorForeground: '#e8eaf0',
    colorMutedForeground: '#8b93a7',
    colorInput: '#1a1e28',
    colorInputForeground: '#e8eaf0',
    colorBorder: '#252a37',
    colorRing: '#7c6aef',
    colorDanger: '#f0526a',
    colorSuccess: '#3ecf8e',
    colorWarning: '#f5a623',
    colorNeutral: '#e8eaf0',
    borderRadius: '10px',
    fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
  },
  elements: {
    cardBox: { border: '1px solid #252a37', boxShadow: 'none' },
  },
};
