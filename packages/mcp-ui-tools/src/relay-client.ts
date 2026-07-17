import { relayToolCallResponseSchema } from '@eduagent/shared';

/**
 * Forwards one tool call to the UiToolRelay (plans/03 §4: POST /tool-call
 * `{tool, args, sessionToken}` on 127.0.0.1). The relay owns auth, validation,
 * persistence, and WS pushes; this client only moves bytes and turns every
 * outcome into a model-readable string.
 */
export interface RelayCallOutcome {
  ok: boolean;
  /** Model-facing text — instructive on success AND on failure. */
  text: string;
}

export async function forwardToolCall(
  relayPort: number,
  tool: string,
  args: unknown,
): Promise<RelayCallOutcome> {
  const sessionToken =
    typeof args === 'object' &&
    args !== null &&
    'session_token' in args &&
    typeof (args as { session_token: unknown }).session_token === 'string'
      ? (args as { session_token: string }).session_token
      : '';

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${relayPort}/tool-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool, args, sessionToken }),
    });
  } catch {
    return {
      ok: false,
      text:
        'The EduAgent UI relay is unreachable, so this UI update could not be delivered. ' +
        'Continue the lesson in chat for now and retry the tool call later in the session.',
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // non-JSON body — fall through to the generic message below
  }
  const parsed = relayToolCallResponseSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data.ok
      ? { ok: true, text: parsed.data.message }
      : { ok: false, text: parsed.data.error };
  }
  return {
    ok: false,
    text: `The UI relay returned an unexpected response (HTTP ${response.status}). Retry the tool call once; if it fails again, continue in chat.`,
  };
}
