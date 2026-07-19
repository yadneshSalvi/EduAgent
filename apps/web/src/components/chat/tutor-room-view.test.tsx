import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { initialTurnStreamState, type TurnStream } from '@/hooks/use-turn-stream';
import { TutorRoomView } from './tutor-room-view';

describe('TutorRoomView archived sessions', () => {
  it('renders history and the revision footer without live chat controls or connection errors', () => {
    const stream: TurnStream = {
      state: {
        ...initialTurnStreamState,
        connection: 'failed',
        history: 'ready',
        items: [
          { id: 'start', role: 'system', text: '[session-start]' },
          { id: 'tutor', role: 'agent', text: 'A joined row represents one matching pair.' },
          { id: 'alex', role: 'user', text: 'So one customer can appear twice.' },
        ],
      },
      send: () => false,
      refetchHistory: () => {},
      dispatch: () => {},
    };

    const html = renderToStaticMarkup(
      <TutorRoomView
        title="The INNER JOIN mental model"
        topicSlug="sql"
        threadId="seed-alex-s04"
        stream={stream}
        archived
        onRevise={() => {}}
        onInterrupt={() => {}}
        onSubmitExercise={() => Promise.resolve()}
        onSubmitQuiz={() => Promise.resolve()}
      />,
    );

    expect(html).toContain('Session started');
    expect(html).toContain('A joined row represents one matching pair.');
    expect(html).toContain('So one customer can appear twice.');
    expect(html).toContain('This session has ended — revise the topic to continue.');
    expect(html).toContain('Revise this topic');
    expect(html).not.toContain('aria-label="Message the tutor"');
    expect(html).not.toContain('Stop the current turn');
    expect(html).not.toContain("Can't reach the tutor");
    expect(html).not.toContain('offline');
  });
});
