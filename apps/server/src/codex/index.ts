/**
 * codex protocol layer (plans/03 §2). AppServerClient is the ONLY module
 * allowed to speak protocol shapes; consumers (ThreadManager, healthz wiring
 * — task #11) import from here and stay protocol-agnostic where possible.
 */
export { AppServerClient } from './AppServerClient.js';
export { AppServerError, AppServerRequestError, AppServerConnectionError } from './errors.js';
export {
  buildElicitationContext,
  defaultElicitationApprover,
  extractElicitationToolName,
} from './elicitation.js';
export { renderMcpConfigArgs } from './mcp-args.js';
export type {
  AppServerChildProcess,
  AppServerClientEventMap,
  AppServerClientOptions,
  AppServerMethodName,
  AppServerMethods,
  BackoffOptions,
  CodexLogger,
  ElicitationApprover,
  ElicitationContext,
  ForkThreadOptions,
  HealthProbe,
  JsonValue,
  McpServerSpec,
  RawNotification,
  ResumeThreadOptions,
  SpawnAppServer,
  StartThreadOptions,
  StartTurnOptions,
  ThreadEvent,
  ThreadEventListener,
  ThreadEventType,
} from './types.js';
