import type { Metadata } from 'next';
import { ReviewFlow } from '@/components/review/review-flow';

export const metadata: Metadata = { title: 'Review' };

/**
 * Review (plans/04 §5): queue → live session → summary, all in one focused
 * single-column flow driven by the review thread's socket.
 */
export default function ReviewPage() {
  return <ReviewFlow />;
}
