/**
 * The values of this run, and runs of other taus.
 *
 * @packageDocumentation
 */

/** A value a run takes (docs/spec/values.md). */
export type Value = string | Handle | readonly Value[] | { readonly [name: string]: Value };

/** A file or a directory, with what the agent does with it. */
export type Handle = { readonly $in: string } | { readonly $out: string } | { readonly $inout: string };

/** How a run ended. */
export interface Result {
	/** Whether it succeeded. */
	readonly ok: boolean;
	/** The agent's final text; empty when it gave none. */
	readonly text: string;
	/** Why it failed, when it did. */
	readonly failure?: string;
}

/** This run's values, by parameter, each handle's path where this agent sees it. */
export declare function values(): { readonly [name: string]: Value };

/**
 * Run the tau at `agent`, a directory, with `values`, by parameter. `agent` and the paths of the
 * handles may be relative to `process.cwd()`. Resolves once the run ends; aborting `signal` stops
 * it, and the run fails.
 * @throws when the run cannot start, such as when `agent` is not a tau, or the values do not fit it.
 */
export declare function run(
	agent: string,
	values: { readonly [name: string]: Value },
	signal?: AbortSignal,
): Promise<Result>;

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export declare const TAU_SKIP: 0;

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export declare const TAU_RUN: 100;

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export declare const TAU_FALLBACK: 101;
