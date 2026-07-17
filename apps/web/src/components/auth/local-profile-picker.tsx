'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, UserRound } from 'lucide-react';
import { localLoginRequestSchema } from '@eduagent/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiConnectionError, ApiError, localLogin } from '@/lib/api';

/**
 * AUTH_MODE=local sign-in (plans/04 §1): create-or-login by handle against
 * POST /auth/local-login (signed cookie session from the agent host), so a
 * judge runs everything with zero accounts.
 */

/** Only same-origin paths — never bounce the login through a foreign URL. */
function safeRedirectTarget(): string {
  const raw = new URLSearchParams(window.location.search).get('redirect_url');
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/app';
}

export function LocalProfilePicker() {
  const router = useRouter();
  const [busyHandle, setBusyHandle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newHandle, setNewHandle] = useState('');

  const signIn = async (handle: string) => {
    const parsed = localLoginRequestSchema.safeParse({ handle });
    if (!parsed.success) {
      setError('Handles are lowercase letters, digits, and dashes — e.g. "alex" or "sam-2".');
      return;
    }
    setBusyHandle(handle);
    setError(null);
    try {
      const me = await localLogin(parsed.data);
      // A learner without a committed profile.md goes to the interview wizard
      // (plans/04 §8); its "Skip for now" link keeps this from ever looping.
      router.push(me.onboarded ? safeRedirectTarget() : '/app/onboarding');
    } catch (err) {
      setBusyHandle(null);
      if (err instanceof ApiConnectionError) {
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 404) {
        setError('The agent host is not in AUTH_MODE=local — set AUTH_MODE=local and restart it.');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Sign-in failed. Try again.');
      }
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-display">Who&apos;s learning?</CardTitle>
        <CardDescription>
          Local mode — no account needed. Your memory lives on this machine.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          className="h-12 justify-start gap-3"
          disabled={busyHandle !== null}
          onClick={() => void signIn('alex')}
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-primary">
            {busyHandle === 'alex' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <UserRound className="size-4" aria-hidden />
            )}
          </span>
          <span className="flex flex-col items-start">
            <span className="text-body-sm font-medium">Alex</span>
            <span className="text-caption text-muted-foreground">demo learner</span>
          </span>
        </Button>

        {showNew ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn(newHandle.trim());
            }}
          >
            <Input
              autoFocus
              value={newHandle}
              onChange={(event) => setNewHandle(event.target.value.toLowerCase())}
              placeholder="your-handle"
              aria-label="New learner handle"
              className="font-mono"
              disabled={busyHandle !== null}
            />
            <Button type="submit" disabled={busyHandle !== null || newHandle.trim() === ''}>
              {busyHandle !== null && busyHandle === newHandle.trim() ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                'Start'
              )}
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            disabled={busyHandle !== null}
            onClick={() => setShowNew(true)}
            className="justify-start gap-2 text-muted-foreground"
          >
            <Plus className="size-4" aria-hidden />
            New learner
          </Button>
        )}

        {error ? (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : null}

        <p className="font-mono text-caption text-muted-foreground/80">AUTH_MODE=local</p>
      </CardContent>
    </Card>
  );
}
