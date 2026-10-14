/**
 * This run's files and args, runs of other TAUs, and init's exit codes.
 *
 * @packageDocumentation
 */

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/**
 * A file of a call given with its mode: needed for an extra file, one the TAU does not declare,
 * and allowed for one it does.
 */
export interface CallFile {
	readonly mode: "in" | "out" | "inout";
	/** Its path, or, for an `in` file, a list of paths. */
	readonly path: string | readonly string[];
	/** What it is, a file or a directory; without it, either. */
	readonly kind?: "file" | "dir";
}

/** A call of a TAU: a path for each of its files, extra files, and its args. */
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
	/** The agent's final text, or init's; empty when it gave none. */
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
 * Run the TAU at `tau`, a directory, with `call`, as its caller: its agent does the task, in a run
 * of its own, which may take minutes. `tau` and the call's paths are yours, such as your files'
 * places; a relative one is `process.cwd()`'s. An `out` file's directory must exist. Its agent sees
 * none of your paths: an arg names a file by its placeholder, as in `"${site}/index.html"`, and a
 * `${` meant as text takes one `$` more, `$${`. Resolves once the run ends: if it
 * succeeded, what its agent left at each `out` and `inout` file is at your path. Aborting `signal`
 * stops it, and the run fails.
 * @throws when the run cannot start, such as when `tau` is not a TAU, or the call does not fit it.
 */
export declare function run(tau: string, call: Call, signal?: AbortSignal): Promise<Result>;

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export declare const TAU_SKIP: 0;

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export declare const TAU_RUN: 100;

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export declare const TAU_FALLBACK: 101;
