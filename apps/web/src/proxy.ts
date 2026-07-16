import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';

// Plain path check instead of Clerk's createRouteMatcher (deprecated in v7).
// Per Clerk's guidance, data-accessing pages should ALSO check auth() locally
// once they exist — this edge check is the UX-level redirect, not the only wall.
function isProtectedRoute(req: NextRequest): boolean {
  const { pathname } = req.nextUrl;
  return pathname === '/app' || pathname.startsWith('/app/');
}

const clerkHandler = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    const { userId } = await auth();
    if (!userId) {
      const loginUrl = new URL('/login', req.url);
      // Relative path only: req.url's origin can differ from what the browser
      // sees (e.g. localhost vs LAN IP behind Next's dev rewrite), and an
      // absolute redirect_url would bounce the user to the wrong host.
      loginUrl.searchParams.set('redirect_url', req.nextUrl.pathname + req.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
  }
});

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  // AUTH_MODE=local (01_architecture §6): judge-friendly local runs need no
  // Clerk account — skip Clerk entirely; the agent host owns the cookie session.
  if (process.env.AUTH_MODE === 'local') {
    return NextResponse.next();
  }
  return clerkHandler(req, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
