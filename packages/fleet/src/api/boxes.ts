/**
 * fleet.gateway.v1's `Boxes`, served from the gateway's boxes: each call as the
 * gateway does it (../gateway.ts), a watch and a lease as long as their
 * call lasts.
 * @module @sleepymug/fleet/api/boxes
 */

import { create } from '@bufbuild/protobuf'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import { Boxes, BoxState, type WatchBoxResponse, WatchBoxResponseSchema } from '@sleepymug/fleet-protocol/gateway'
import type { FleetGateway } from '../gateway.ts'

export function boxesRoutes(gateway: FleetGateway): (router: ConnectRouter) => void {
  return router => router.service(Boxes, {
    create: req => gateway.createBox(req),
    list: req => ({ boxes: gateway.listBoxes(req.labels) }),
    get: req => gateway.getBox(req.box),
    start: async (req) => {
      await gateway.box(req.box).start()
      return {}
    },
    stop: async (req) => {
      await gateway.box(req.box).stop()
      return {}
    },
    stopWhenVacant: async (req) => {
      await gateway.box(req.box).stopWhenVacant()
      return {}
    },
    remove: async (req) => {
      await gateway.removeBox(req.box)
      return {}
    },
    watch: (req, ctx) => watch(gateway, req.box, ctx),
    async *lease(req, ctx) {
      const managed = gateway.box(req.box)
      const occupant = { kind: req.occupant?.kind ?? '', id: req.occupant?.id ?? '' }
      if (req.start) {
        const { release } = await managed.hold(occupant)
        try {
          yield {}
          await ended(gateway, req.box, ctx)
        } finally {
          release()
        }
      } else {
        const release = managed.occupy(occupant)
        try {
          yield {}
          await ended(gateway, req.box, ctx)
        } finally {
          release()
        }
      }
    },
  })
}

/** A box's state, now and at each change, until it is removed or the call ends. */
async function* watch(gateway: FleetGateway, box: string, ctx: HandlerContext): AsyncGenerator<WatchBoxResponse> {
  const states: (BoxState | 'removed')[] = []
  let wake: (() => void) | undefined
  const stop = gateway.watch(box, (state) => {
    states.push(state)
    wake?.()
  })
  const onAbort = (): void => { wake?.() }
  ctx.signal.addEventListener('abort', onAbort)
  try {
    while (!ctx.signal.aborted) {
      const state = states.shift()
      if (state === 'removed') return
      if (state !== undefined) {
        yield create(WatchBoxResponseSchema, { state })
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
      wake = undefined
    }
  } finally {
    stop()
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

/** Settles once the call ends, or the box is removed. */
function ended(gateway: FleetGateway, box: string, ctx: HandlerContext): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.signal.aborted) {
      resolve()
      return
    }
    const stop = gateway.watch(box, (state) => {
      if (state !== 'removed') return
      stop()
      resolve()
    })
    ctx.signal.addEventListener('abort', () => {
      stop()
      resolve()
    }, { once: true })
  })
}
