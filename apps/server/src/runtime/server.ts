/**
 * Bun adapter that binds the Hono application and the WebSocket gateway to `Bun.serve` (D-090: runtime/ may use Bun).
 * Everything it serves is runtime-neutral code from http/ and realtime/; swapping the runtime means replacing this file.
 */
import { LIMITS } from '@chatapp/contracts'
import type { Hono } from 'hono'
import type { Services } from '../http/context.ts'
import type { Connection, Gateway, Socket } from '../realtime/gateway.ts'
import { type Handshake, prepareHandshake } from '../realtime/handshake.ts'

type SocketData = { handshake: Handshake; connection?: Connection }

export type RunningServer = {
  port: number
  stop: () => Promise<void>
}

export function startServer(parts: {
  // biome-ignore lint/suspicious/noExplicitAny: Hono's env generics are irrelevant to the adapter, which only calls fetch().
  app: Hono<any>
  services: Services
  gateway: Gateway
  hostname: string
  port: number
}): RunningServer {
  const { app, services, gateway } = parts
  const clientIp = (request: Request, peer: string | undefined) =>
    services.resolveClientIp(
      peer,
      request.headers.get('x-forwarded-for'),
      request.headers.get('x-real-ip'),
    )

  const server = Bun.serve<SocketData>({
    port: parts.port,
    hostname: parts.hostname,
    // JSON endpoints are limited to 128 KiB by the request budget; this ceiling only bounds what Bun will buffer.
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 10,
    async fetch(request, srv) {
      const peer = srv.requestIP(request)?.address
      if (new URL(request.url).pathname === '/ws') {
        const handshake = await prepareHandshake(services, request, clientIp(request, peer))
        if (srv.upgrade(request, { data: { handshake } })) return undefined
        return new Response('WebSocket upgrade required', { status: 426 })
      }
      return app.fetch(request, { peerAddress: () => peer })
    },
    websocket: {
      maxPayloadLength: LIMITS.wsFrameBytes,
      backpressureLimit: LIMITS.wsSendBufferBytes,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      idleTimeout: 120,
      open(ws) {
        const { handshake } = ws.data
        if (!handshake.ok) {
          ws.close(handshake.code, handshake.reason)
          return
        }
        const socket: Socket = {
          send: (text) => void ws.send(text),
          close: (code, reason) => ws.close(code, reason),
          ping: () => void ws.ping(),
          bufferedAmount: () => ws.getBufferedAmount(),
        }
        ws.data.connection = gateway.accept(socket, handshake.identity)
      },
      message(ws, message) {
        if (ws.data.connection) {
          gateway.receive(
            ws.data.connection,
            typeof message === 'string' ? message : new Uint8Array(message),
          )
        }
      },
      pong(ws) {
        if (ws.data.connection) gateway.pong(ws.data.connection)
      },
      close(ws, code) {
        if (ws.data.connection) gateway.closed(ws.data.connection, code)
      },
    },
  })
  return {
    port: server.port ?? parts.port,
    stop: async () => {
      await server.stop(true)
    },
  }
}
