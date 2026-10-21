import { startNodeAIRelay } from './server'

const relay = await startNodeAIRelay()
console.log(`OpenPencil AI relay listening on ${relay.url}`)

function shutdown() {
  void relay.stop().then(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
