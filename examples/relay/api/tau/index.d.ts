/**
 * This run's files and args, runs of other taus, and init's exit codes.
 *
 * @packageDocumentation
 */

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/**
 * A file of a call given with its mode: one the tau does not declare, which the call gives the
 * agent beside those it declares, or one it does.
 */
export interface CallFile {
	readonly mode: "in" | "out" | "inout";
	/** Its path, or, for an `in` file, a list of paths. */
	readonly path: string | readonly string[];
	/** What it is, a file or a directory; without it, either. */
	readonly kind?: "file" | "dir";
}

/** A call of a tau (docs/spec/calls.md): a path for each of its files, extra files, and its args. */
export interface Call {
	/** A path for each file, by name, or, for an `in` file, a list of paths, or the file with its mode. */
	readonly files?: { readonly [name: string]: string | readonly string[] | CallFile };
	/** The args, which fit the tau's schema. */
	readonly args?: { readonly [name: string]: Json };
}

/** How a run ended. */
export interface Result {
	/** Whether it succeeded. */
	readonly ok: boolean;
	/** The agent's final text; empty when it gave none. */
	readonly text: string;
	/** Why it failed, when it did. */
	readonly failure?: string;
}

/** Where this agent sees each of this run's files, by name, extra files included. */
export declare function files(): { readonly [name: string]: string };

/**
 * This run's args, their placeholders expanded: each `${self}`, `${name}` naming a file, and
 * `${name}` naming an arg, and each run of `$` before a `{` with one `$` less.
 */
export declare function args(): { readonly [name: string]: Json };

/**
 * Run the tau at `agent`, a directory, with `call`. `agent` and the paths of the call's files may
 * be relative to `process.cwd()`. Resolves once the run ends; aborting `signal` stops it, and the
 * run fails.
 * @throws when the run cannot start, such as when `agent` is not a tau, or the call does not fit it.
 */
export declare function run(agent: string, call: Call, signal?: AbortSignal): Promise<Result>;

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export declare const TAU_SKIP: 0;

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export declare const TAU_RUN: 100;

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export declare const TAU_FALLBACK: 101;
