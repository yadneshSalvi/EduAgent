import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '@/lib/api';
import TrackLayout from '@/app/app/(shell)/tracks/[slug]/layout';

const state = vi.hoisted(() => ({ error: null as unknown }));

vi.mock('@/hooks/use-tracks', () => ({
  useTrackDetail: () => ({ error: state.error }),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

describe('TrackLayout notFound guard (QA F3)', () => {
  it('still fires for a valid-looking unknown slug across child routes', async () => {
    state.error = new ApiError(404, 'not_found', 'No track');
    const layout = await TrackLayout({
      children: <div>Any nested child route</div>,
      params: Promise.resolve({ slug: 'unknown-track' }),
    });

    expect(() => renderToStaticMarkup(layout)).toThrow('NEXT_NOT_FOUND');
  });

  it('renders child content when the track exists', async () => {
    state.error = null;
    const layout = await TrackLayout({
      children: <div>Known track child</div>,
      params: Promise.resolve({ slug: 'sql-interview' }),
    });

    expect(renderToStaticMarkup(layout)).toContain('Known track child');
  });
});
