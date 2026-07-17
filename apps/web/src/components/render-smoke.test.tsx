import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineEntry } from '@eduagent/shared';
import { ActivityStrip } from './dashboard/activity-strip';
import { FileViewer } from './memory/file-viewer';
import { TimeMachineSlider } from './memory/time-machine-slider';

/**
 * Render smoke (server markup, no browser): the pure presentational pieces
 * produce sensible DOM from real-shaped data. Interactive behavior is
 * covered by the browser verification pass.
 */

describe('ActivityStrip', () => {
  const activity = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 3, 18) + i * 86_400_000).toISOString().slice(0, 10),
    count: i % 7 === 0 ? 3 : 0,
  }));

  it('renders the 90 cells and the event total', () => {
    const html = renderToStaticMarkup(<ActivityStrip activity={activity} />);
    expect(html).toContain('90-day activity');
    expect((html.match(/title="/g) ?? []).length).toBe(90);
    expect(html).toContain(`>${13 * 3}</span> events`);
  });

  it('shows the teaching caption when everything is zero', () => {
    const html = renderToStaticMarkup(
      <ActivityStrip activity={activity.map((a) => ({ ...a, count: 0 }))} />,
    );
    expect(html).toContain('No activity yet');
  });
});

describe('TimeMachineSlider', () => {
  const commits: TimelineEntry[] = ['a1', 'b2', 'c3'].map((sha, i) => ({
    sha: sha.repeat(4),
    type: 'learn',
    topic: 'sql',
    headline: `commit ${sha}`,
    bullets: [],
    deltas: [],
    date: `2026-07-1${i}T10:00:00.000Z`,
  }));

  it('renders a dot per commit and both range thumbs', () => {
    const html = renderToStaticMarkup(
      <TimeMachineSlider commits={commits} range={{ a: 0, b: 2 }} onChange={() => {}} />,
    );
    expect((html.match(/title="/g) ?? []).length).toBe(3);
    expect(html).toContain('Time machine: from commit');
    expect(html).toContain('Time machine: to commit');
  });

  it('renders nothing with fewer than two commits', () => {
    const html = renderToStaticMarkup(
      <TimeMachineSlider commits={commits.slice(0, 1)} range={{ a: 0, b: 0 }} onChange={() => {}} />,
    );
    expect(html).toBe('');
  });
});

describe('FileViewer', () => {
  const masteryYaml = [
    'topic: sql',
    'display_name: SQL',
    'updated: 2026-07-16T08:00:00.000Z',
    'concepts:',
    '  - id: inner-join',
    '    name: INNER JOIN',
    '    mastery: 0.72',
    '    confidence: medium',
    '    last_assessed: 2026-07-14',
    '    review_count: 1',
    '    prereqs: []',
    '    evidence:',
    '      - date: 2026-07-14',
    "        note: 'Solved ex-014 without hints'",
  ].join('\n');

  it('renders inline mastery bars for mastery.yaml files', () => {
    const html = renderToStaticMarkup(
      <FileViewer path="topics/sql/mastery.yaml" content={masteryYaml} />,
    );
    expect(html).toContain('INNER JOIN');
    expect(html).toContain('role="meter"');
    expect(html).toContain('0.72');
  });

  it('splits markdown frontmatter into a yaml block', () => {
    const html = renderToStaticMarkup(
      <FileViewer
        path="profile.md"
        content={'---\nname: Casey\n---\n\nCasey is a data analyst.'}
      />,
    );
    expect(html).toContain('name: Casey');
    expect(html).toContain('Casey is a data analyst.');
  });
});
