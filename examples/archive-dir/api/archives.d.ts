/**
 * Archives folders with the fleet host: each is packed as a tarball and
 * sent there, and the host keeps a receipt of what it received. Each session
 * has receipts of its own, kept while the fleet host runs.
 *
 * @packageDocumentation
 */
/** What the fleet host received. */
export interface Receipt {
    /** The name it was sent under. */
    name: string;
    /** The tarball's size in bytes. */
    bytes: number;
    /** Its SHA-256, in hex. */
    sha256: string;
    /** The paths it holds, in its order, as tar lists them without a leading `./`; folders end in `/`. */
    entries: string[];
}
/**
 * Pack a folder into a tarball, its paths relative to the folder, and send
 * it to the fleet host. A receipt kept under the same name is replaced.
 * @param dir - The folder to send.
 * @param name - What to keep its receipt under; the folder's own name by default.
 */
export declare function archiveDir(dir: string, name?: string): Promise<Receipt>;
/** The receipts kept, oldest first. */
export declare function list(): Promise<Receipt[]>;
