/**
 * Pure, side-effect-free epistemic kernel.
 *
 * This barrel exports only in-memory types and deterministic functions. It is
 * deliberately not registered with MCP and does not admit or persist records.
 */
export * from './types.js';
export * from './schema.js';
export * from './validate.js';
export * from './prime.js';
export * from './synthesize.js';
export * from './maintenance.js';
export * from './task-ledger.js';
export * from './self-correct-bridge.js';
export * from './dream-bridge.js';
