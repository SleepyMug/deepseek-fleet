#!/usr/bin/env node
/**
 * The `tau` command in a box (tau's docs/spec/client.md#the-tau-command),
 * as tau has it: the tau service's environment has it run taus through its
 * socket adaptor on the service's socket in the box, which the fleet host
 * relays to dsh-tau, so each run is the box's run's, its paths the box's.
 * @module @sleepymug/dsh-tau-box/tau
 */

import '@sleepymug/tau/cli'
