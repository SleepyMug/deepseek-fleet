/**
 * A notebook of short notes, each with tags to find it by later. Each
 * session has a notebook of its own, kept while the fleet host runs.
 *
 * @packageDocumentation
 */

/** A saved note. */
export interface Note {
	id: number;
	text: string;
	tags: string[];
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: string[]): Promise<Note>;

/** Notes carrying `tag`, oldest first. */
export declare function byTag(tag: string): Promise<Note[]>;
