/**
 * Phase 1 module stub — nothing here is wired yet.
 *
 * Lands here (plans/03_backend.md §2–3.1, plans/01_architecture.md §4):
 * - AppServerClient: JSON-RPC/JSONL over stdio to the `codex app-server`
 *   child — spawn + initialize handshake, pending-request map, typed
 *   notification events, auto-restart with backoff. Wire shapes are locked to
 *   docs/PROTOCOL_NOTES.md (Phase 0 spike output) — never guessed.
 * - ThreadManager: ensureThread / resumeAll / forkForExam / startTurn; owns
 *   all ItemMirror writes and per-thread turn serialization.
 */
export {};
