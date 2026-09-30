/**
 * Receives the tarballs a session sends, and keeps a receipt of each: its
 * size, its digest and what it holds. Each session has receipts of its own,
 * kept while the fleet host runs.
 *
 * @packageDocumentation
 */

/** What the service received. */
export interface Receipt {
	/** The name it was sent under. */
	name: string;
	/** Its size in bytes. */
	bytes: number;
	/** Its SHA-256, in hex. */
	sha256: string;
	/** The paths it holds, in its order, as tar lists them without a leading `./`; folders end in `/`. */
	entries: string[];
}

/**
 * Receive a tarball, and say what it holds. A receipt kept under the same name is replaced.
 * @param name - What to keep its receipt under.
 * @param tarball - An uncompressed tarball, as `tar -cf` writes one.
 */
export declare function store(name: string, tarball: Uint8Array): Promise<Receipt>;

/** The receipts kept, oldest first. */
export declare function list(): Promise<Receipt[]>;
