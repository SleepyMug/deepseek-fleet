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
