import { createClerkClient } from '@clerk/backend';

/**
 * The narrow slice of Clerk's Backend API that POST /auth/demo-login uses
 * (plans/08 §5-6): create the standing demo identity once, then mint short-
 * lived sign-in tokens for it. Tests inject a fake against this interface —
 * the real client only ever runs in clerk mode with a real secret key.
 */

export interface DemoClerkUser {
  id: string;
}

export interface DemoSignInToken {
  token: string;
  userId: string;
}

export interface DemoClerkClient {
  /**
   * The standing demo user, if the Clerk instance already has one (looked up
   * by the deterministic demo email). A reseeded/fresh DATABASE must relink
   * to it rather than create a duplicate — the email is a unique identifier
   * in Clerk, so a second createUser would fail forever.
   */
  findDemoUser(params: { handle: string }): Promise<DemoClerkUser | null>;
  createDemoUser(params: { handle: string; displayName: string }): Promise<DemoClerkUser>;
  createSignInToken(params: { userId: string; expiresInSeconds: number }): Promise<DemoSignInToken>;
}

/**
 * The demo identity's email domain. The address exists only to satisfy
 * Clerk's at-least-one-identifier rule (and to key findDemoUser) — sign-in
 * tokens bypass identifier auth entirely and nothing is ever mailed to it.
 */
const DEMO_EMAIL_DOMAIN = 'eduagent.aiquantized.com';

function demoEmailFor(handle: string): string {
  return `${handle}.demo@${DEMO_EMAIL_DOMAIN}`;
}

export function createDemoClerkClient(secretKey: string): DemoClerkClient {
  const clerk = createClerkClient({ secretKey });
  return {
    async findDemoUser({ handle }) {
      const list = await clerk.users.getUserList({ emailAddress: [demoEmailFor(handle)] });
      const user = list.data[0];
      return user ? { id: user.id } : null;
    },
    async createDemoUser({ handle, displayName }) {
      const user = await clerk.users.createUser({
        emailAddress: [demoEmailFor(handle)],
        firstName: displayName,
        skipPasswordRequirement: true,
        publicMetadata: { eduagentDemo: true, handle },
      });
      return { id: user.id };
    },
    async createSignInToken({ userId, expiresInSeconds }) {
      const token = await clerk.signInTokens.createSignInToken({ userId, expiresInSeconds });
      return { token: token.token, userId: token.userId };
    },
  };
}
