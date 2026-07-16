import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { Geist, JetBrains_Mono, Newsreader } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { clerkAppearance } from '@/lib/clerk-appearance';
import './globals.css';

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
});

const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: {
    default: 'EduAgent — the tutor that never forgets you',
    template: '%s · EduAgent',
  },
  description:
    'An AI tutor whose memory of you is a git repository. Every lesson ends with a commit to your knowledge model.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // AUTH_MODE is a runtime switch (01 §6): force dynamic rendering so every
  // request re-reads the env instead of baking the mode into prerendered HTML
  // (judges flip clerk↔local without rebuilding; keyless local builds work).
  await connection();

  // Dark is the primary theme (05 §2) — html-class strategy, dark by default.
  const html = (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${newsreader.variable} ${jetbrainsMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );

  // AUTH_MODE=local: no Clerk keys required anywhere in the tree (01 §6).
  if (process.env.AUTH_MODE === 'local') {
    return html;
  }

  return (
    <ClerkProvider appearance={clerkAppearance} signInUrl="/login" afterSignOutUrl="/">
      {html}
    </ClerkProvider>
  );
}
