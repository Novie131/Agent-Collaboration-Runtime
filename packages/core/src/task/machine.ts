import { TERMINAL_STATES, type TaskState } from '@acr/protocol/collaboration.js';

/** Task transitions (SPEC §16). Guards that need more than the state live in the hub. */
export type TaskAction =
  | 'claim'
  | 'block'
  | 'submit'
  | 'request_changes'
  | 'accept'
  | 'escalate'
  | 'resolve'
  | 'fail'
  | 'cancel';

const TABLE: Record<TaskAction, Partial<Record<TaskState, TaskState>>> = {
  claim: { READY: 'CLAIMED', CHANGES_REQUESTED: 'CLAIMED', BLOCKED: 'CLAIMED', CLAIMED: 'CLAIMED' },
  block: { CLAIMED: 'BLOCKED' },
  submit: { CLAIMED: 'IMPLEMENTED' },
  request_changes: { IMPLEMENTED: 'CHANGES_REQUESTED' },
  accept: { IMPLEMENTED: 'COMPLETED' },
  escalate: {
    READY: 'ESCALATED',
    CLAIMED: 'ESCALATED',
    BLOCKED: 'ESCALATED',
    IMPLEMENTED: 'ESCALATED',
    CHANGES_REQUESTED: 'ESCALATED',
  },
  // `resolve` target is chosen by the developer; see resolveTargets.
  resolve: {},
  fail: { ESCALATED: 'FAILED', BLOCKED: 'FAILED' },
  cancel: {
    READY: 'CANCELLED',
    CLAIMED: 'CANCELLED',
    BLOCKED: 'CANCELLED',
    IMPLEMENTED: 'CANCELLED',
    CHANGES_REQUESTED: 'CANCELLED',
    ESCALATED: 'CANCELLED',
  },
};

export const RESOLVE_TARGETS = ['READY', 'COMPLETED', 'FAILED', 'CANCELLED'] as const satisfies readonly TaskState[];

export function nextState(from: TaskState, action: TaskAction): TaskState | undefined {
  return TABLE[action][from];
}

export const isTerminal = (s: TaskState) => TERMINAL_STATES.has(s);
