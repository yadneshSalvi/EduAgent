import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DevTurnPreview } from '@/components/dev/dev-turn-preview';

export const metadata: Metadata = { title: 'Turn preview (dev)' };

/**
 * Dev-only harness (task 1C §7): replays scripted WsEvent fixtures through
 * the SAME reducer + components as the live tutor room, so streaming, the
 * commit toast, and the Diff Drawer can be built and verified before the WS
 * gateway (task #11) lands. 404s in production builds.
 */
export default function TurnPreviewPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return <DevTurnPreview />;
}
