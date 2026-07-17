/**
 * Thread layer (plans/03 §3.1): ThreadManager ties the protocol client,
 * workspaces, memory pipeline, and WS gateway together per thread.
 */
export {
  GREETING_INPUT,
  ThreadManager,
  type EnsureThreadResult,
  type ThreadEventSink,
  type ThreadManagerDeps,
  type ThreadService,
} from './ThreadManager.js';
