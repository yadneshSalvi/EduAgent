import Link from 'next/link';
import { SignIn } from '@clerk/nextjs';
import { ExploreAsAlexCard } from '@/components/auth/explore-as-alex-card';
import { LocalProfilePicker } from '@/components/auth/local-profile-picker';

/**
 * /login (plans/04 §1): Clerk <SignIn/> + "Explore as Alex" demo entry.
 * AUTH_MODE=local renders the simple profile picker instead — no Clerk
 * anywhere in the tree, so local judge runs need no keys.
 */
export default function LoginPage() {
  const isLocal = process.env.AUTH_MODE === 'local';

  return (
    <main className="relative flex min-h-dvh flex-col">
      <header className="flex h-16 items-center px-8">
        <Link href="/" className="rounded-sm font-display text-h4 font-semibold tracking-tight">
          EduAgent
        </Link>
      </header>

      <div className="flex flex-1 items-center justify-center p-6">
        {isLocal ? (
          <LocalProfilePicker />
        ) : (
          <div className="flex flex-col items-start justify-center gap-6 lg:flex-row">
            {/* Hash routing keeps Clerk's multi-step flow on /login without a catch-all route. */}
            <SignIn routing="hash" fallbackRedirectUrl="/app" />
            <div className="w-full max-w-sm lg:w-80">
              <ExploreAsAlexCard />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
