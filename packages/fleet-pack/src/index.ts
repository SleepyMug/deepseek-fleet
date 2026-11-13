/**
 * `@sleepymug/fleet-pack`: trees of files as fleet moves them.
 * - ./tar.ts: tar archives, written and read in one pass.
 * - ./tree.ts: a folder's entries, entries of one's own, and an archive unpacked.
 * - ./stage.ts: a node package as installed, with what it depends on.
 * - ./digest.ts: a tree's digest.
 * @module @sleepymug/fleet-pack
 */

export { ArchiveError, readTar, writeTar, type EntryType, type TarEntry, type TarHeader, type WriteEntry } from './tar.ts'
export { bytesEntry, dirEntry, linkEntry, packTree, pathEntry, treeEntries, unpackTree, type UnpackOptions } from './tree.ts'
export { locate, stageModules, stagePackage } from './stage.ts'
export { digestOf } from './digest.ts'
