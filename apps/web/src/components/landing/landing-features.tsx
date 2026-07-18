'use client';

import Image from 'next/image';
import { motion, MotionConfig } from 'motion/react';
import { GitCommitHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Landing feature beats (plans/04 §9): three real screenshots from the
 * product — tutor room mid-commit, dashboard, exam results — each with one
 * sharp claim. The mock commit toast animates over the first shot when it
 * scrolls into view (§5 causality: the lesson produced the commit).
 * Screenshots live in public/landing/, captured from the seeded demo world.
 */

const EASE = [0.2, 0.8, 0.2, 1] as const;

interface Beat {
  id: string;
  kicker: string;
  title: string;
  body: string;
  image: string;
  alt: string;
}

const BEATS: Beat[] = [
  {
    id: 'learn',
    kicker: 'learn',
    title: 'Every lesson ends in a commit.',
    body: 'You work in a real room — chat, code editor, quizzes graded by running your code. When something clicks, the tutor commits it to your memory: mastery deltas, misconceptions closed, the next review scheduled. You can read every line it writes about you.',
    image: '/landing/tutor-room.png',
    alt: 'EduAgent tutor room: chat with the tutor beside a code workbench, a memory commit toast in the corner',
  },
  {
    id: 'memory',
    kicker: 'remember',
    title: 'Your knowledge, measured honestly.',
    body: 'A readiness gauge, a per-concept mastery heatmap, forgetting curves projected from your review history. Every number on the dashboard is derived from commits in your memory repo — nothing is vibes, everything is auditable.',
    image: '/landing/dashboard.png',
    alt: 'EduAgent dashboard: readiness gauge, mastery heatmap, and forgetting-curve chart',
  },
  {
    id: 'exam',
    kicker: 'prove it',
    title: 'Exams forked from your memory.',
    body: 'One click forks your learner model into a timed mock exam aimed straight at your weakest concepts. Results land as a commit too — the exam updates what the tutor knows about you, and the next lesson starts smarter.',
    image: '/landing/exam-results.png',
    alt: 'EduAgent exam results: score hero with per-question review and mastery deltas',
  },
];

/** The §6.1 toast, replayed as a mock: delta ticks 0.40 → 0.72 on entry. */
function MockCommitToast() {
  return (
    <motion.div
      // Framer strips transforms from the first client render for
      // reduced-motion users, so the SSR style attribute can't match — the
      // runtime immediately owns these styles either way.
      suppressHydrationWarning
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ amount: 0.9 }}
      transition={{ duration: 0.45, ease: EASE, delay: 0.5 }}
      className="pointer-events-none absolute -bottom-5 -right-3 w-[300px] rounded-lg border bg-surface p-3.5 text-left shadow-(--shadow-overlay) sm:-right-6"
      aria-hidden
    >
      <div className="flex items-center gap-2">
        <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-caption text-primary-legible">
          learn(sql)
        </span>
        <span className="flex items-center gap-1 font-mono text-caption text-muted-foreground">
          <GitCommitHorizontal className="size-3.5" aria-hidden />
          a3f9c21
        </span>
      </div>
      <p className="mt-2 text-body-sm font-medium leading-snug">
        LEFT JOIN vs INNER JOIN finally clicked
      </p>
      <div className="mt-2 flex items-center gap-2 font-mono text-caption">
        <span className="text-muted-foreground">left-join</span>
        <span className="numeric text-muted-foreground">0.40</span>
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <motion.span
            className="absolute inset-y-0 left-0 rounded-full bg-success"
            initial={{ width: '40%' }}
            whileInView={{ width: '72%' }}
            viewport={{ amount: 0.9 }}
            transition={{ duration: 0.8, ease: 'easeInOut', delay: 1.05 }}
          />
        </span>
        <span className="numeric font-semibold text-success">0.72</span>
      </div>
    </motion.div>
  );
}

function FeatureShot({ beat, withToast }: { beat: Beat; withToast: boolean }) {
  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg border bg-surface shadow-(--shadow-overlay)">
        {/* Faux window chrome keeps the screenshots reading as the product. */}
        <div className="flex items-center gap-1.5 border-b bg-surface-2/60 px-3.5 py-2.5">
          <span className="size-2.5 rounded-full bg-border" aria-hidden />
          <span className="size-2.5 rounded-full bg-border" aria-hidden />
          <span className="size-2.5 rounded-full bg-border" aria-hidden />
          <span className="ml-2 font-mono text-caption text-muted-foreground">
            eduagent — {beat.id}
          </span>
        </div>
        {/* unoptimized: the shots are pre-sized captures; skipping the image
            optimizer keeps the Docker runtime dependency-free. */}
        <Image src={beat.image} alt={beat.alt} width={1440} height={900} unoptimized className="block w-full" />
      </div>
      {withToast ? <MockCommitToast /> : null}
    </div>
  );
}

export function LandingFeatures() {
  // MotionConfig (not useReducedMotion branches): the SSR markup and the
  // client's first render must be byte-identical for reduced-motion users —
  // the runtime strips transforms, keeping the fades (05 §5).
  return (
    <MotionConfig reducedMotion="user">
      <section aria-label="What EduAgent does" className="relative mx-auto w-full max-w-6xl px-6 pb-28">
      <div className="flex flex-col gap-24 lg:gap-28">
        {BEATS.map((beat, index) => (
          <motion.article
            key={beat.id}
            suppressHydrationWarning
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.25 }}
            transition={{ duration: 0.5, ease: EASE }}
            className={cn(
              'grid items-center gap-8 lg:grid-cols-2 lg:gap-14',
              index % 2 === 1 && 'lg:[&>*:first-child]:order-2',
            )}
          >
            <FeatureShot beat={beat} withToast={index === 0} />
            <div className="flex max-w-lg flex-col gap-4">
              <p className="font-mono text-caption uppercase tracking-widest text-primary">
                {beat.kicker}
              </p>
              <h2 className="font-display text-h2 font-medium tracking-tight text-balance">
                {beat.title}
              </h2>
              <p className="text-body text-muted-foreground">{beat.body}</p>
            </div>
          </motion.article>
        ))}
      </div>
      </section>
    </MotionConfig>
  );
}
