import type { Metadata } from 'next';
import { MemoryExplorer } from '@/components/memory/memory-explorer';

export const metadata: Metadata = { title: 'Memory' };

/**
 * The memory explorer (plans/04 §7): tree · viewer · history under the Time
 * Machine, plus "Export my memory". Everything reads committed git content
 * via /api/memory/*.
 */
export default function MemoryPage() {
  return <MemoryExplorer />;
}
