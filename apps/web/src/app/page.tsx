import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Landing (plans/04 §9): minimal dark hero — name, tagline, one-line pitch,
 * CTA to /login. Doubles as the video intro shot; feature beats with real
 * screenshots land in Phase 5.
 */
export default function LandingPage() {
  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-1/4 h-2/3 bg-[radial-gradient(ellipse_50%_100%_at_50%_0%,var(--accent-soft),transparent_70%)]"
      />

      <header className="relative flex h-16 items-center justify-between px-8">
        <span className="font-display text-h4 font-semibold tracking-tight">EduAgent</span>
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Sign in</Link>
        </Button>
      </header>

      <section className="relative flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-24 text-center">
        <p className="font-mono text-caption text-muted-foreground">
          an AI tutor whose memory of you is a git repository
        </p>
        <h1 className="max-w-3xl font-display text-h1 font-medium tracking-tight text-balance md:text-display">
          The tutor that never forgets <em className="italic">you</em>.
        </h1>
        <p className="max-w-xl text-lead text-muted-foreground text-balance">
          Every lesson ends with a commit to a learner model you can read, diff, and take anywhere.
          Watch the AI diff your brain.
        </p>
        <Button asChild size="lg">
          <Link href="/login">
            Start learning
            <ArrowRight aria-hidden />
          </Link>
        </Button>

        <div className="mt-8 w-full max-w-md rounded-lg border bg-surface p-4 text-left font-mono text-body-sm">
          <p className="text-muted-foreground">
            <span className="text-primary">a3f9c21</span> learn(sql): LEFT JOIN vs INNER JOIN
            finally clicked
          </p>
          <p className="mt-2 rounded-sm bg-diff-add px-2 py-1 text-success">
            + mastery: <span className="numeric">0.40 → 0.72</span>
          </p>
          <p className="mt-1 rounded-sm bg-diff-del px-2 py-1 text-danger">
            - misconception: “ON filters after the join”
          </p>
        </div>
      </section>

      <footer className="relative flex h-14 items-center justify-center">
        <p className="font-mono text-caption text-muted-foreground/70">
          built on codex · your memory is yours
        </p>
      </footer>
    </main>
  );
}
