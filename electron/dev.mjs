// Dev runner: Vite dev server via its JS API, then Electron pointed at it.
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electron from 'electron'

const server = await createServer()
await server.listen()
const url = server.resolvedUrls.local[0]
console.log(`[dev] vite at ${url}`)

// ponytail: --no-sandbox only if chrome-sandbox SUID is missing on this Linux box (not needed unless Electron refuses to start)
const args = ['.']
const child = spawn(electron, args, {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})
child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
