/**
 * Runs other agents in the tau format, each as a run of its own: the fleet
 * host starts it as a subagent of this session, in this session's project,
 * in a container of its own, where it works in a folder of that container's
 * own, with nothing of this container mounted. Its `in` paths are copied
 * from this container when it starts, and its `out` paths are copied back
 * into this container once it completes. A tau with a `share` path cannot
 * run here: no other container can share this one's files.
 *
 * @packageDocumentation
 */
/** How a run ended. */
export interface Result {
    /**
     * Whether the run succeeded: its agent finished, and left each `out` path
     * as its tau declares, which is now in place in this container.
     */
    ok: boolean;
    /** The agent's final message; empty when it wrote none. */
    message: string;
    /** Why the run failed, when it did. */
    failure?: string;
}
/**
 * Run the tau at `agent`, a folder in this container, with `args` as its
 * arguments, as `tau run` does. `agent` and the path arguments may be
 * relative to `process.cwd()`, and the run sees the variables its tau.json
 * lists, as `process.env` has them. The call waits until the run ends, however
 * long that takes; aborting `signal` cancels the run.
 * @throws when the run cannot start, such as when `agent` is not a tau, the arguments do not fit it, or an `in` path is missing.
 */
export declare function run(agent: string, args: readonly string[], signal?: AbortSignal): Promise<Result>;
