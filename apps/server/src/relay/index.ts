/**
 * UiToolRelay (plans/03 §4): 127.0.0.1-only HTTP server with a single
 * `POST /tool-call {tool, args, sessionToken}` route, called by the
 * `packages/mcp-ui-tools` stdio server for every ui_* MCP tool call.
 *
 * Auth = session token → Thread row (constant-time compare); args are
 * zod-parsed against the shared schemas; dispatch persists (Exercise rows,
 * ItemMirror) and pushes WS events. EVERY response string — success or
 * failure — is written for the AGENT to read: results double as guardrails
 * ("wait for the submission; do not reveal the solution") and errors must be
 * self-correctable ("re-read the session_token from your instructions").
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import type { Prisma, PrismaClient, Thread } from '@prisma/client';
import {
  artifactPayloadSchema,
  assessmentPayloadSchema,
  exercisePayloadSchema,
  isUiToolName,
  quizPayloadSchema,
  relayToolCallRequestSchema,
  uiToolArgSchemas,
  UI_TOOL_NAMES,
  type QuizPayload,
  type RelayToolCallResponse,
  type UiToolArgs,
  type UiToolName,
} from '@eduagent/shared';
import { constantTimeEqual } from '../api/http.js';
import type { CodexLogger } from '../codex/index.js';
import type { ThreadEventSink } from '../threads/index.js';
import type { WorkspaceManager } from '../workspace/index.js';

/** Exam tools are registered (so the model sees stable tooling) but inert until Phase 4. */
const EXAM_TOOLS: ReadonlySet<UiToolName> = new Set(['ui_create_exam', 'ui_grade_exam']);

/** Artifacts can be sizeable HTML; anything past this is a runaway payload. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const NOOP_LOGGER: CodexLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface UiToolRelayDeps {
  prisma: PrismaClient;
  sink: ThreadEventSink;
  workspaces: Pick<WorkspaceManager, 'pathFor'>;
  logger?: CodexLogger;
}

export interface UiToolRelayOptions {
  /** Port to bind on 127.0.0.1; 0 = ephemeral (tests). */
  port: number;
}

export interface RelayResult {
  status: number;
  body: RelayToolCallResponse;
}

const ok = (message: string): RelayResult => ({ status: 200, body: { ok: true, message } });
const fail = (status: number, error: string): RelayResult => ({
  status,
  body: { ok: false, error },
});

export class UiToolRelay {
  private readonly prisma: PrismaClient;
  private readonly sink: ThreadEventSink;
  private readonly workspaces: Pick<WorkspaceManager, 'pathFor'>;
  private readonly log: CodexLogger;
  private readonly port: number;
  private server: HttpServer | null = null;

  constructor(deps: UiToolRelayDeps, opts: UiToolRelayOptions) {
    this.prisma = deps.prisma;
    this.sink = deps.sink;
    this.workspaces = deps.workspaces;
    this.log = deps.logger ?? NOOP_LOGGER;
    this.port = opts.port;
  }

  /** Binds 127.0.0.1 only (plans/01 §7) and resolves with the actual port. */
  async listen(): Promise<number> {
    if (this.server !== null) throw new Error('UiToolRelay is already listening');
    const server = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : this.port;
    this.log.info({ port }, 'UiToolRelay listening on 127.0.0.1');
    return port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handleHttp(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const respond = ({ status, body }: RelayResult): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };

    if (req.method !== 'POST' || req.url !== '/tool-call') {
      respond(fail(404, 'The UI relay serves exactly one route: POST /tool-call.'));
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      respond(
        fail(
          413,
          `Tool-call payload rejected: ${err instanceof Error ? err.message : 'read error'}.`,
        ),
      );
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      respond(fail(400, 'Tool-call body was not valid JSON.'));
      return;
    }

    try {
      respond(await this.handleToolCall(json));
    } catch (err) {
      this.log.error({ err }, 'UiToolRelay dispatch threw');
      respond(
        fail(
          500,
          'The UI relay hit an internal error delivering this call. Retry the tool call once; if it fails again, continue the lesson in chat.',
        ),
      );
    }
  }

  /**
   * The whole pipeline for one call — exposed for tests (the HTTP layer above
   * is a thin shell). Never throws for expected failures; every branch returns
   * an agent-readable string.
   */
  async handleToolCall(body: unknown): Promise<RelayResult> {
    const request = relayToolCallRequestSchema.safeParse(body);
    if (!request.success) {
      return fail(400, 'Tool-call body must be {tool, args, sessionToken}.');
    }
    const { tool, args, sessionToken } = request.data;

    if (!isUiToolName(tool)) {
      return fail(
        404,
        `Unknown tool "${tool}". Available EduAgent UI tools: ${UI_TOOL_NAMES.join(', ')}.`,
      );
    }

    const thread = await this.authenticate(sessionToken);
    if (thread === null) {
      this.log.warn({ tool }, 'relay: invalid session token');
      return fail(
        401,
        'Your session_token was not recognized. Re-read the session_token from your ' +
          'instructions and pass it exactly in the session_token argument, then call the tool again.',
      );
    }

    if (EXAM_TOOLS.has(tool)) {
      return fail(
        400,
        `${tool} is registered but exam mode activates in a later phase of EduAgent. ` +
          'Do not retry it — continue the session without exam tooling.',
      );
    }

    const parsed = uiToolArgSchemas[tool].safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; ');
      this.log.warn(
        { tool, threadId: thread.id, issues, tag: 'prompt-bug' },
        'relay: invalid args',
      );
      return fail(
        400,
        `Invalid arguments for ${tool} — ${issues}. Fix these fields and call the tool again.`,
      );
    }

    const result = await this.dispatch(tool, parsed.data as never, thread);
    this.log.info(
      { tool, threadId: thread.id, userId: thread.userId, ok: result.body.ok },
      'relay: tool call handled',
    );
    return result;
  }

  /**
   * Token → Thread row. The unique lookup is followed by a constant-time
   * digest compare (plans/03 §4) so the comparison itself never leaks
   * prefix-match timing; a dummy compare levels the not-found path. Tokens
   * die with their thread: only `active` threads may drive the UI.
   */
  private async authenticate(sessionToken: string): Promise<Thread | null> {
    const thread =
      sessionToken === '' ? null : await this.prisma.thread.findUnique({ where: { sessionToken } });
    const matches = constantTimeEqual(sessionToken, thread?.sessionToken ?? randomUUID());
    return thread !== null && matches && thread.status === 'active' ? thread : null;
  }

  private dispatch<K extends UiToolName>(
    tool: K,
    args: UiToolArgs[K],
    thread: Thread,
  ): Promise<RelayResult> {
    switch (tool) {
      case 'ui_push_exercise':
        return this.pushExercise(args as UiToolArgs['ui_push_exercise'], thread);
      case 'ui_push_quiz':
        return this.pushQuiz(args as UiToolArgs['ui_push_quiz'], thread);
      case 'ui_push_artifact':
        return this.pushArtifact(args as UiToolArgs['ui_push_artifact'], thread);
      case 'ui_record_assessment':
        return this.recordAssessment(args as UiToolArgs['ui_record_assessment'], thread);
      case 'ui_grade_exercise':
        return this.gradeExercise(args as UiToolArgs['ui_grade_exercise'], thread);
      case 'ui_grade_quiz':
        return this.gradeQuiz(args as UiToolArgs['ui_grade_quiz'], thread);
      default:
        // EXAM_TOOLS are rejected before dispatch; this is unreachable.
        return Promise.resolve(fail(400, `${tool} is not dispatchable yet.`));
    }
  }

  // ------------------------------------------------------------------- tools

  private async pushExercise(
    args: UiToolArgs['ui_push_exercise'],
    thread: Thread,
  ): Promise<RelayResult> {
    const testsError = await this.verifyHiddenTests(thread.userId, args.id, args.tests_path);
    if (testsError !== null) return testsError;

    const existing = await this.prisma.exercise.findUnique({
      where: { userId_slug: { userId: thread.userId, slug: args.id } },
    });
    if (existing !== null && existing.status !== 'open') {
      return fail(
        409,
        `Exercise id "${args.id}" was already used and graded (${existing.status}) for this ` +
          'learner. Pick the next unused id (ids increment: ex-001, ex-002, …) and call again.',
      );
    }

    const data = {
      slug: args.id,
      userId: thread.userId,
      threadId: thread.id,
      language: args.language,
      title: args.title,
      prompt: args.prompt_md,
      starterCode: args.starter_code,
      concepts: args.concepts as Prisma.InputJsonValue,
      difficulty: args.difficulty,
      status: 'open',
    };
    if (existing !== null) {
      await this.prisma.exercise.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.exercise.create({ data });
    }

    // The browser payload NEVER carries session_token or tests_path (plans/03
    // §5) — parsing with the omit-schema strips them.
    const payload = exercisePayloadSchema.parse(args);
    await this.prisma.itemMirror.create({
      data: {
        threadId: thread.id,
        role: 'agent',
        kind: 'exercise_ref',
        payload: payload as Prisma.InputJsonValue,
      },
    });
    this.sink.emitToThread(thread.id, { type: 'workbench.exercise', exercise: payload });

    return ok(
      `Exercise ${args.id} is now visible in the learner's workbench editor. Before this turn ` +
        `ends, git commit the .exercises/${args.id}/ workdir per the memory skill (e.g. ` +
        `"system(<topic>): author ${args.id} with hidden tests"). Then wait for their ` +
        'submission — a grading task will arrive when they submit. Do not reveal the hidden ' +
        'tests or the solution, and do not grade until then.',
    );
  }

  /**
   * Guardrail for the teach skill's authoring flow: hidden tests must exist
   * under `.exercises/<id>/tests/` in the workspace BEFORE the push.
   */
  private async verifyHiddenTests(
    userId: string,
    exerciseId: string,
    testsPath: string,
  ): Promise<RelayResult | null> {
    const expectedPrefix = `.exercises/${exerciseId}/`;
    const normalized = path.posix.normalize(testsPath.replace(/\\/g, '/')).replace(/\/+$/, '');
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split('/').includes('..') ||
      !`${normalized}/`.startsWith(expectedPrefix)
    ) {
      return fail(
        400,
        `tests_path must live under ${expectedPrefix} (workspace-relative, e.g. ` +
          `"${expectedPrefix}tests/") — got "${testsPath}". Write the hidden tests there and call again.`,
      );
    }

    const absolute = path.join(this.workspaces.pathFor(userId), normalized);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(absolute);
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      return fail(
        400,
        `No hidden tests found at ${normalized}. Before pushing: write meaningful tests under ` +
          `.exercises/${exerciseId}/tests/ (happy path + at least one edge case), run them ` +
          'yourself so they fail on the starter and pass on your solution, THEN call ' +
          'ui_push_exercise again.',
      );
    }
    return null;
  }

  private async pushQuiz(args: UiToolArgs['ui_push_quiz'], thread: Thread): Promise<RelayResult> {
    // mcq/predict_output check instantly client-side, which requires `answer`
    // (plans/03 §5 accepted team decision — answers DO ship for learn/review).
    const missingAnswers = args.questions.filter(
      (q) => (q.type === 'mcq' || q.type === 'predict_output') && q.answer === undefined,
    );
    if (missingAnswers.length > 0) {
      return fail(
        400,
        `Questions ${missingAnswers.map((q) => q.id).join(', ')} are mcq/predict_output but ` +
          'carry no `answer`. Include the correct answer for every mcq and predict_output ' +
          'question (they are checked instantly in the UI) and call ui_push_quiz again.',
      );
    }
    const badMcq = args.questions.filter(
      (q) => q.type === 'mcq' && q.answer !== undefined && !(q.options ?? []).includes(q.answer),
    );
    if (badMcq.length > 0) {
      return fail(
        400,
        `On questions ${badMcq.map((q) => q.id).join(', ')} the \`answer\` is not one of the ` +
          '`options`. Make each mcq answer exactly match one option string and call again.',
      );
    }

    const payload = quizPayloadSchema.parse(args);
    await this.prisma.itemMirror.create({
      data: {
        threadId: thread.id,
        role: 'agent',
        kind: 'quiz',
        payload: payload as Prisma.InputJsonValue,
      },
    });
    this.sink.emitToThread(thread.id, { type: 'workbench.quiz', quiz: payload });

    const shortCount = args.questions.filter((q) => q.type === 'short').length;
    return ok(
      `Quiz ${args.id} (${args.questions.length} question${args.questions.length === 1 ? '' : 's'}) ` +
        'is now visible to the learner. Wait for their submission — mcq and predict_output are ' +
        'checked instantly in the UI' +
        (shortCount > 0
          ? `; you will grade the ${shortCount} short answer${shortCount === 1 ? '' : 's'} when the submission arrives.`
          : '.') +
        ' Do not reveal the answers.',
    );
  }

  private async pushArtifact(
    args: UiToolArgs['ui_push_artifact'],
    thread: Thread,
  ): Promise<RelayResult> {
    const payload = artifactPayloadSchema.parse(args);
    this.sink.emitToThread(thread.id, { type: 'workbench.artifact', artifact: payload });
    return ok(
      `Artifact "${args.title}" is now rendered in the learner's workbench. Refer to it in chat ` +
        'if it helps, and continue the lesson.',
    );
  }

  private async recordAssessment(
    args: UiToolArgs['ui_record_assessment'],
    thread: Thread,
  ): Promise<RelayResult> {
    const payload = assessmentPayloadSchema.parse(args);
    await this.prisma.activityEvent.create({
      data: {
        userId: thread.userId,
        kind: 'assessment',
        meta: { threadId: thread.id, ...payload } as Prisma.InputJsonValue,
      },
    });
    const event = { type: 'assessment.recorded' as const, ...payload };
    this.sink.emitToThread(thread.id, event);
    this.sink.emitToUser(thread.userId, event);
    const n = payload.concept_deltas.length;
    return ok(
      `Assessment recorded (${n} concept delta${n === 1 ? '' : 's'}). The learner's dashboard ` +
        'updated live. Make sure the mastery files and the git commit carry these exact numbers ' +
        'per the memory skill — the file is the ledger, this call is only the live signal.',
    );
  }

  private async gradeExercise(
    args: UiToolArgs['ui_grade_exercise'],
    thread: Thread,
  ): Promise<RelayResult> {
    const exercise = await this.prisma.exercise.findUnique({
      where: { userId_slug: { userId: thread.userId, slug: args.exercise_id } },
      include: { attempts: { orderBy: { createdAt: 'desc' } } },
    });
    if (exercise === null) {
      return fail(
        404,
        `No exercise "${args.exercise_id}" exists for this learner. Grade using the exact id ` +
          'you pushed with ui_push_exercise.',
      );
    }
    const attempt = exercise.attempts.find((a) => a.verdict === null);
    if (attempt === undefined) {
      return fail(
        409,
        `Exercise "${args.exercise_id}" has no ungraded submission. Wait for the learner to ` +
          'submit before grading; a grading task will arrive with their code.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.exercise.update({
        where: { id: exercise.id },
        data: { status: args.verdict },
      }),
      this.prisma.exerciseAttempt.update({
        where: { id: attempt.id },
        data: { verdict: args.verdict, feedback: args.feedback_md, gradedAt: new Date() },
      }),
    ]);
    await this.prisma.activityEvent.create({
      data: {
        userId: thread.userId,
        kind: args.verdict === 'passed' ? 'exercise_pass' : 'exercise_fail',
        meta: { threadId: thread.id, exerciseId: args.exercise_id, attemptId: attempt.id },
      },
    });

    const event = {
      type: 'exercise.graded' as const,
      exerciseId: args.exercise_id,
      verdict: args.verdict,
      feedback: args.feedback_md,
    };
    // The workbench lives on the exercise's own thread; grading normally runs
    // there too, but deliver to both in case they ever differ.
    this.sink.emitToThread(exercise.threadId, event);
    if (exercise.threadId !== thread.id) this.sink.emitToThread(thread.id, event);
    this.sink.emitToUser(thread.userId, event);

    return ok(
      `Verdict "${args.verdict}" delivered for ${args.exercise_id}. Now: explain the result in ` +
        'chat per the teach-skill rubric (what passed, what failed and why, one targeted hint — ' +
        'never the full solution on a first failure), then update the learner model, commit per ' +
        'the memory skill, and mirror the change with ui_record_assessment.',
    );
  }

  private async gradeQuiz(args: UiToolArgs['ui_grade_quiz'], thread: Thread): Promise<RelayResult> {
    const quiz = await findQuizForUser(this.prisma, thread.userId, args.quiz_id);
    if (quiz === null) {
      return fail(
        404,
        `No quiz "${args.quiz_id}" was pushed for this learner. Grade using the exact quiz id ` +
          'you pushed with ui_push_quiz.',
      );
    }
    const validIds = new Set(quiz.payload.questions.map((q) => q.id));
    const unknown = args.results.filter((r) => !validIds.has(r.question_id));
    if (unknown.length > 0) {
      return fail(
        400,
        `Question id${unknown.length === 1 ? '' : 's'} ${unknown.map((r) => r.question_id).join(', ')} ` +
          `do not exist on quiz "${args.quiz_id}". Valid question ids: ${[...validIds].join(', ')}. ` +
          'Fix the question_id values and call again.',
      );
    }

    await this.prisma.activityEvent.create({
      data: {
        userId: thread.userId,
        kind: 'quiz_graded',
        meta: {
          threadId: thread.id,
          quizId: args.quiz_id,
          results: args.results,
        } as Prisma.InputJsonValue,
      },
    });

    const event = { type: 'quiz.graded' as const, quizId: args.quiz_id, results: args.results };
    this.sink.emitToThread(quiz.threadId, event);
    if (quiz.threadId !== thread.id) this.sink.emitToThread(thread.id, event);
    this.sink.emitToUser(thread.userId, event);

    return ok(
      `Grades delivered for quiz ${args.quiz_id} (${args.results.length} result${args.results.length === 1 ? '' : 's'}). ` +
        'Now discuss the results briefly in chat, then update the learner model, commit per the ' +
        'memory skill, and mirror with ui_record_assessment.',
    );
  }
}

/**
 * Quizzes have no table (plans/03 §4): each push is an ItemMirror row
 * (`kind:"quiz"`, payload incl. its id) — this is also how
 * `POST /api/quiz/:id/submit` resolves quiz → thread. SQLite Json columns are
 * opaque to Prisma, so resolution scans the user's quiz rows newest-first.
 */
export async function findQuizForUser(
  prisma: PrismaClient,
  userId: string,
  quizId: string,
): Promise<{ threadId: string; payload: QuizPayload } | null> {
  const rows = await prisma.itemMirror.findMany({
    where: { kind: 'quiz', thread: { userId } },
    orderBy: { createdAt: 'desc' },
  });
  for (const row of rows) {
    const parsed = quizPayloadSchema.safeParse(row.payload);
    if (parsed.success && parsed.data.id === quizId) {
      return { threadId: row.threadId, payload: parsed.data };
    }
  }
  return null;
}

/** Reads the request body with a hard byte cap. */
function readBody(req: import('node:http').IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
