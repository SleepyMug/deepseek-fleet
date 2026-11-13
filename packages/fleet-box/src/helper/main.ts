/**
 * The helper's process, each box's command: it serves the box (./helper.ts)
 * until the box stops, whose SIGTERM ends what it started, then exits. The
 * gateway gives it, in its environment, the gateway's socket and the box's
 * id; outside a container, a root the box's layout is under.
 * @module @sleepymug/fleet-box/helper/main
 */

import { BOX_VARIABLE, boxLayout, GATEWAY_VARIABLE, ROOT_VARIABLE } from '@sleepymug/fleet-protocol/layout'
import { startHelper } from './helper.ts'

const log = (message: string): void => { process.stderr.write(`fleet-helper: ${message}\n`) }
const gateway = process.env[GATEWAY_VARIABLE]
const box = process.env[BOX_VARIABLE]
if (gateway === undefined || box === undefined) {
  log(`$${GATEWAY_VARIABLE} and $${BOX_VARIABLE} say which gateway to dial, for which box`)
  process.exit(2)
}
const helper = await startHelper({ gateway, box, layout: boxLayout(process.env[ROOT_VARIABLE] ?? '/'), log })
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void helper.close().finally(() => { process.exit(0) })
  })
}
