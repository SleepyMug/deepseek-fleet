import type { Receipt } from "@svc/archives";

/**
 * Pack the directory `dir` into a tarball, its paths relative to it, and send it to the archives
 * service under `name`, the directory's own name by default. Resolves to what the service received.
 */
export declare function archiveDir(dir: string, name?: string): Promise<Receipt>;
