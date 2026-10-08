/**
 * A notebook of short notes, each with tags to find them by later.
 *
 * Notes persist: once `addNote` resolves, the note is kept, and `byTag` finds it, for every program
 * that uses the same notebook, in this run and in later ones. Which notebook a run's programs use
 * is the implementation's. An implementation for testing, a mock, may discard notes, but only once
 * no live reference reaches them.
 *
 * @packageDocumentation
 */

/** A saved note. */
export interface Note {
	/** Its number, which no other note of the notebook has. */
	readonly id: number;
	/** What it remembers. */
	readonly text: string;
	/** Labels to find it by. */
	readonly tags: readonly string[];
	/** When it was added. */
	readonly written: Date;
}

/**
 * Remember something, and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: readonly string[]): Promise<Note>;

/** The notes carrying `tag`, oldest first. */
export declare function byTag(tag: string): Promise<Note[]>;
