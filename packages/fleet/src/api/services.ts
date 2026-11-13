/**
 * fleet.gateway.v1's `Services`, served from the gateway's services: a spec
 * staged, a package uploaded, and the services registered now.
 * @module @sleepymug/fleet/api/services
 */

import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect'
import { Services, type UploadPackageRequest } from '@sleepymug/fleet-protocol/gateway'
import type { FleetGateway } from '../gateway.ts'
import { DigestMismatch } from '../store.ts'

export function servicesRoutes(gateway: FleetGateway): (router: ConnectRouter) => void {
  return router => router.service(Services, {
    stage: async (req) => {
      const spec = await gateway.stage(req)
      return { spec: spec.digest, upload: spec.package !== '' && !(await gateway.store.has(spec.package)) }
    },
    upload: async (requests) => {
      const iterator = requests[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done === true || first.value.part.case !== 'digest') throw new ConnectError('fleet: an upload names its package\'s digest first', Code.InvalidArgument)
      const digest = first.value.part.value
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (let next: IteratorResult<UploadPackageRequest> = await iterator.next(); next.done !== true; next = await iterator.next()) {
          if (next.value.part.case !== 'chunk') throw new ConnectError('fleet: an upload names its digest once', Code.InvalidArgument)
          yield next.value.part.value
        }
      }
      try {
        await gateway.upload(digest, chunks())
      } catch (error) {
        if (error instanceof DigestMismatch) throw new ConnectError(error.message, Code.InvalidArgument)
        throw error
      }
      return {}
    },
    list: async () => ({ services: await gateway.services() }),
  })
}
