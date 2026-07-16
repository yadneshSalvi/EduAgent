import Link from 'next/link';
import { UserRound } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * AUTH_MODE=local sign-in (plans/04 §1): a simple profile picker instead of
 * Clerk, so a judge can run everything with zero accounts. The real cookie
 * session comes from the agent host (POST /auth/local/login) in Phase 2 —
 * until then the picker just walks into the app.
 */
export function LocalProfilePicker() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-display">Who&apos;s learning?</CardTitle>
        <CardDescription>
          Local mode — no account needed. Your memory lives on this machine.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline" className="h-12 justify-start gap-3">
          <Link href="/app">
            <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-primary">
              <UserRound className="size-4" aria-hidden />
            </span>
            <span className="flex flex-col items-start">
              <span className="text-body-sm font-medium">Alex</span>
              <span className="text-caption text-muted-foreground">demo learner</span>
            </span>
          </Link>
        </Button>
        <Button variant="ghost" disabled className="justify-start text-muted-foreground">
          + New learner
        </Button>
        <p className="font-mono text-caption text-muted-foreground/80">AUTH_MODE=local</p>
      </CardContent>
    </Card>
  );
}
