'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSignIn } from '@clerk/nextjs';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiConnectionError, ApiError, demoLogin, markSessionEstablished } from '@/lib/api';

/**
 * Demo entry for the hosted judge run (plans/04 §1, 08 §6): access code →
 * POST /auth/demo-login → Clerk sign-in token, consumed via the ticket
 * strategy. Rendered in clerk mode only (login/page.tsx keeps the local
 * profile picker for AUTH_MODE=local), so useSignIn always has a provider.
 */

function friendlyError(err: unknown): string {
  if (err instanceof ApiConnectionError) return err.message;
  if (err instanceof ApiError) {
    switch (err.status) {
      case 403:
        return "That access code isn't right — check the testing instructions.";
      case 429:
        return 'Too many attempts from this connection. Wait a minute and retry.';
      case 502:
        return 'The sign-in service hiccuped. Try again in a moment.';
      case 503:
        return 'Demo login is not enabled on this deployment.';
      default:
        return err.message;
    }
  }
  return 'Demo sign-in failed. Try again in a moment.';
}

export function ExploreAsAlexCard() {
  const router = useRouter();
  const { signIn } = useSignIn();
  const [accessCode, setAccessCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await demoLogin({ accessCode: accessCode.trim() });
      // clerk/javascript#8219: ticket sign-in can fail when the browser
      // already holds a Clerk session (single-session mode). Surfaced as the
      // friendly error below; the full round-trip is proven on the deployed
      // origin (docs/DEPLOY_RUNBOOK.md).
      const ticketResult = await signIn.ticket({ ticket: token });
      if (ticketResult.error) throw ticketResult.error;
      if (signIn.status !== 'complete') {
        throw new Error(`ticket sign-in did not complete (status ${signIn.status})`);
      }
      const finalizeResult = await signIn.finalize();
      if (finalizeResult.error) throw finalizeResult.error;
      markSessionEstablished();
      // Alex is seeded with a committed profile.md — always onboarded.
      router.push('/app');
    } catch (err) {
      console.error('demo login failed', err);
      setBusy(false);
      setError(friendlyError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-display">Explore as Alex</CardTitle>
        <CardDescription>
          A seeded learner with three weeks of history — full dashboard, live memory, real commits.
          No account needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          aria-label="Demo access"
          onSubmit={(event) => {
            event.preventDefault();
            void enter();
          }}
        >
          <Input
            type="password"
            name="accessCode"
            placeholder="Access code"
            autoComplete="off"
            aria-label="Access code"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            disabled={busy}
          />
          <Button type="submit" disabled={busy || accessCode.trim() === ''} className="w-full">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : 'Enter the demo'}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : null}
        <p className="text-caption text-muted-foreground">
          The access code is in the judges&apos; testing instructions.
        </p>
      </CardContent>
    </Card>
  );
}
