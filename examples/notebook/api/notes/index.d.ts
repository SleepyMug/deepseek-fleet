/**
 * A notebook of short notes, each with tags to find them by later.
 *
 * Once `addNote` resolves, the note is kept, and `byTag` finds it, for every program that uses the
 * same notebook. Which notebook a run's programs use, and so whether a later run finds its notes,
 * is the implementation's.
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
