# fleet-net

How fleet's ends reach one another over HTTP/2, `@sleepymug/fleet-net`,
knowing nothing of boxes or services: the gateway, the helper and
fleet-sdk all dial, listen, tunnel and carry calls with it, and none of
them imports another for it.

## Provides

| Export | What it does |
|---|---|
| `listen(path, { request, tunnel?, mode? })` | A Unix socket that takes HTTP/2 and HTTP/1.1 alike: a connection that opens with HTTP/2's preface, as a Connect or gRPC client's does, is HTTP/2, any other HTTP/1.1, as curl's is; both go to one handler, as Node's servers give them, so a Connect router serves either. Each tunnel asked for, a WebSocket's upgrade on HTTP/1.1 or its extended CONNECT on HTTP/2, goes to `tunnel` as a `TunnelRequest`; an upgrade or a CONNECT that is not a WebSocket's is refused, and without `tunnel` none is taken. A socket no one answers on is taken over; one another process serves is refused. Its mode is 0600 unless given. |
| `dial(path)` | An `Upstream`: an HTTP/2 connection to a socket, dialed as a call needs it, and again once lost; an idle one keeps no process alive. |
| `sessionUpstream(session)` | An `Upstream` through one connection already made, such as a tunnel's; once it is closed, its calls fail as unavailable. |
| `openTunnel({ socket, path, protocol, headers, server, via? })` | The dialer's end of a tunnel: a WebSocket at `path`, its subprotocol `protocol`, saying `headers`, opened `via` an HTTP/1.1 upgrade, unless it says `http2`, an extended CONNECT; once taken, `server`, an HTTP/2 server such as a Connect router's, serves the calls that come over it. A refusal is a `TunnelRefused`, with its status, headers and message. |
| `keepTunnel({ open, log?, recover?, fatal? })` | A tunnel kept open: opened again whenever it closes or fails to open, after a pause, a tenth of a second at first, twice as long each time, up to two seconds; `recover` runs before each try after a failure, and `fatal` says a first failure is for good. |
| `TunnelRequest` | The listener's end, as `listen` gives it: its `path`, `headers`, the subprotocols it offers, `protocols`, and `via`; `accept(protocol)` takes it and calls the dialer over it, an `AcceptedTunnel`, and `refuse(status, message, headers?)` refuses it, the same over either. |
| `webSocketStream(connection, role)` | WebSocket's binary messages over a stream, as a byte stream, its frames passed on as they come; a client's masked, as RFC 6455 has it. |
| `forward(req, res, upstream, { path, headers?, drop? })` | Carry a call through: the request, HTTP/1.1 or HTTP/2, goes on as an HTTP/2 stream at `path`, its headers less a hop's own and those `drop` names, with `headers`; the answer comes back as it is, its headers, its body and its trailers, read as they come both ways, never decoded. A side that goes away cancels the other's. |
| `refuse(req, res, error)` | Refuse a call as its protocol has it, by its content type, without reading it: gRPC and gRPC-Web with the status in its headers, Connect's streams with an end-stream message, anything else, Connect's unary calls among them, with an HTTP status and the error as JSON; its details kept, so the caller's client reads it as from the server. |
| `connectTransport(upstream, base?, interceptors?)` | Connect's calls, in its binary format, through an upstream, each at `base` and its method's path. |

## Design

- **A tunnel turns a connection around.** The dialer opens a WebSocket,
  and once the listener takes it, the WebSocket carries HTTP/2, the
  listener its client and the dialer its server. So a server that cannot be
  dialed, behind its own network, on a machine of its own, is called all the
  same: a service's server and a box's helper are each a plain Connect
  server on a tunnel they opened.
- **Why a WebSocket.** Proxies and load balancers pass upgrades by name,
  and the name they pass is `websocket`; and HTTP/2 has no upgrade at all,
  only the extended CONNECT of RFC 8441, which WebSocket alone has a name
  in too. So a tunnel is a WebSocket either way, over HTTP/1.1 as most
  proxies pass it, or over HTTP/2 where the path is HTTP/2 end to end, its
  subprotocol saying what it carries. The WebSocket is a byte stream and no
  more: its messages' bounds mean nothing, and HTTP/2 inside keeps alive and
  paces what goes through it.
- **Carrying is per call**: each call is its own HTTP/2 stream both ways,
  so HTTP/2's flow control paces each, a cancellation is a stream's reset,
  and a deadline is a header like any other.
- **The origin** of every call is `http://fleet`: a socket names its server.

## Built on

- Node's `net`, `http` and `http2`.
- `@connectrpc/connect` and `@connectrpc/connect-node`: their session
  manager, for `dial`, their transports, and their protocols' error forms,
  for `refuse`.
