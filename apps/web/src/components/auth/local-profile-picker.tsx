'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, UserRound } from 'lucide-react';
import { localLoginRequestSchema, type LocalUsersResponse } from '@eduagent/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiConnectionError, ApiError, listLocalUsers, localLogin } from '@/lib/api';

/**
 * AUTH_MODE=local sign-in (plans/04 §1): existing profiles from
 * GET /auth/local-users as one-click sign-ins (QA finding m6), plus
 * create-or-login by handle against POST /auth/local-login (signed cookie
 * session from the agent host), so a judge runs everything with zero accounts.
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

  // /login renders outside the /app providers (no query client) — plain fetch.
  // Errors (e.g. clerk mode's 404) just leave the list empty; login still works.
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [users, setUsers] = useState<LocalUsersResponse['users']>([]);
  useEffect(() => {
    const controller = new AbortController();
    listLocalUsers(controller.signal)
      .then((response) => setUsers(response.users))
      .catch(() => {})
      .finally(() => setUsersLoaded(true));
    return () => controller.abort();
  }, []);

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
      // The first track is onboarding: its generation turn bootstraps profile.md.
      router.push(me.onboarded ? safeRedirectTarget() : '/app/tracks/new');
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
        {!usersLoaded ? (
          <div className="flex items-center gap-2 px-1 py-3 font-mono text-caption text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            looking for learners on this machine…
          </div>
        ) : (
          users.map((user) => (
            <Button
              key={user.handle}
              variant="outline"
              className="h-12 justify-start gap-3"
              disabled={busyHandle !== null}
              onClick={() => void signIn(user.handle)}
            >
              <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-primary-legible">
                {busyHandle === user.handle ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <UserRound className="size-4" aria-hidden />
                )}
              </span>
              <span className="flex flex-col items-start">
                <span className="text-body-sm font-medium">{user.displayName}</span>
                <span className="font-mono text-caption text-muted-foreground">{user.handle}</span>
              </span>
            </Button>
          ))
        )}

        {showNew ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn(newHandle.trim());
            }}
          >
            <div className="flex gap-2">
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
            </div>
            <p className="text-caption text-muted-foreground">
              A new handle starts a fresh learner with an empty memory — pick your existing profile
              above to continue where you left off.
            </p>
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

        <p className="font-mono text-caption text-muted-foreground">AUTH_MODE=local</p>
      </CardContent>
    </Card>
  );
}
