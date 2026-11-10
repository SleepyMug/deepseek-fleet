/**
 * The box's channel to the host: one HTTP/2 connection, which the helper
 * makes to the host's socket at the layout's `CHANNEL`, carrying the
 * connections programs in the box open to its services' sockets, each a
 * stream of its own. The helper sends one request a connection, `POST` to
 * {@link servicePath} of the service, whose body is what the program
 * sends, up to its end, and the host answers {@link OPENED} before the
 * response's body, what the service sends back, up to its end: so each
 * side's end is a half-close, as on a socket, and a reset stream is a cut
 * connection. Only the box's helper reaches the socket, which is the box's
 * own, so the host knows the box by the socket a stream comes in on, never
 * by what the box says. HTTP/2's own flow control paces each stream and the
 * connection. Shared by both ends, so it holds only types and constants.
 * @module @sleepymug/fleet-protocol/channel
 */

/** The path of a service's streams. */
export function servicePath(name: string): string {
  return `/services/${name}`
}

/** The service a path names, or undefined for a path that names none. */
export function serviceOf(path: string | undefined): string | undefined {
  const match = /^\/services\/([a-z][a-z0-9-]*)$/u.exec(path ?? '')
  return match?.[1]
}

/** The status of a stream the host passes on to its service. */
export const OPENED = 200

/** The status of a stream for a service the box does not have now. */
export const NO_SERVICE = 404

/** How many bytes of one stream either side may send that the other has not read: the stream's window, both ways. */
export const CONNECTION_WINDOW = 1024 * 1024

/** How many bytes of all of them, together: the connection's window, both ways. */
export const CHANNEL_WINDOW = 16 * CONNECTION_WINDOW
