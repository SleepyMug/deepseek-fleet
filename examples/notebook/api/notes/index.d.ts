/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

/** A saved note. */
export interface Note {
  readonly id: number;
  text: string;
  tags: string[];
  written: Date;
}

/**
 * Remember something, and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: string[]): Promise<Note>;

/** The notes carrying `tag`, oldest first. */
export declare function byTag(tag: string): Promise<Note[]>;
