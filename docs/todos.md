# TODOs

- **Helper socket directory.** The dsh-ssh helper hard-codes its socket root as `mkdtemp('/tmp/dsh-ssh-')`, so its sockets sit in the model-writable container `/tmp`, where a routine `rm -rf /tmp/*` breaks later spawns in that session. Move the root to a dedicated mount such as `/run/fleet`, ideally through an upstream option rather than a `node --import` shim that wraps `mkdtemp`.
