# fleet-pack

Trees of files as fleet moves them, `@sleepymug/fleet-pack`: a service's
package from its server to the gateway, a box's tree from the gateway to
its helper, a folder into a box and out; and a node package as installed,
with what it depends on, as the image and a service's server stage one.

## Provides

| Export | What it does |
|---|---|
| `writeTar(entries)`, `readTar(bytes, what?)` | Tar archives, POSIX.1-2001's pax format as far as fleet uses it: files, folders and symlinks, a pax header for a name, a target or a size that does not fit, written and read in one pass. The reader takes GNU tar's archives too, its long names among them, and refuses, an `ArchiveError`, an entry of any other kind, a name that is absolute or has `.` or `..` in it, and an archive cut short. |
| `treeEntries(dir, at?)`, `pathEntry(path, at)`, `bytesEntry`, `linkEntry`, `dirEntry` | A folder's entries, under `at`, folders before what they hold, in order of name, what is neither a file, a folder nor a symlink left out; and entries of one's own, so that one archive is put together from several places. |
| `packTree(dir)`, `unpackTree(bytes, dir, { what?, followLinks? })` | A folder as an archive; an archive into a folder, made if missing, each entry in place of what is at its path, what else is there kept, modes as the archive says, a folder's once what is in it is written. It never writes through a symlink, the folder's or one the archive made, unless `followLinks` says to, as into a box's own folders. |
| `stagePackage(root, target, arch?)` | A package as installed, copied to `target`, and every package it depends on, each the instance Node finds from the package that depends on it, to `target/node_modules`, in pnpm's layout, without hoisting; a workspace or linked package as `pnpm pack` would pack it, from its `files`. |
| `stageModules(roots, target, arch?)` | Several packages so, each by its name in `target/node_modules`, as a node_modules a program below `target` imports them from. |
| `digestOf(dir)` | The SHA-256 of a tree as it is, in hex: each entry's path, kind and permission bits, a file's bytes and a link's target, in order of path, so that the same tree has the same digest wherever it is. |

## Design

- **Nothing is installed or built** where a package goes: it runs what the
  machine that staged it has installed, so a box must be linux on that
  machine's architecture, which staging checks, and an optional dependency
  for another platform is left out.
- **What is unpacked has the digest of what was packed**: modes, links and
  bytes all go through, so a tree checked by its digest is the tree sent.

## Built on

Node alone.
