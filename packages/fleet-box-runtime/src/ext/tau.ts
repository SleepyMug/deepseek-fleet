/**
 * The caller's side of tau's library (tau's docs/spec/library.md), for an
 * extension's client in the box, which finds only fleet-box-runtime and Node's
 * modules: it packs a run's call from the box's files, and puts a run's
 * result at them. The `tau` API's client (fleet-ext-tau) runs taus with it.
 * @module fleet-box-runtime/ext/tau
 */

export { applyResult, packCall, runTau, type Finished, type PackedCall, type Result, type Runtime, type Targets } from '@sleepymug/tau/call'
