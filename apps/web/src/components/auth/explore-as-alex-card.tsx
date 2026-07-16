import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Demo entry for the hosted judge run (plans/04 §1): access code →
 * POST /auth/demo-login → Clerk sign-in token. Wired up in Phase 5;
 * until then the button stays disabled.
 */
export function ExploreAsAlexCard() {
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
        <form className="flex flex-col gap-3" aria-label="Demo access">
          <Input
            type="password"
            name="accessCode"
            placeholder="Access code"
            autoComplete="off"
            aria-label="Access code"
          />
          <Button type="submit" disabled className="w-full">
            Enter the demo
          </Button>
        </form>
        <p className="text-caption text-muted-foreground/80">
          Demo entry opens with the hosted build — it&apos;s not wired up yet.
        </p>
      </CardContent>
    </Card>
  );
}
