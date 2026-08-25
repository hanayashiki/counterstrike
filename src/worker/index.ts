/**
 * Stateless edge Worker in front of the match. It does two things: route
 * WebSocket upgrades into the right `GameRoom` Durable Object, and serve the
 * built client from the static asset binding.
 */
import { GameRoom } from './game-room';

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  TARGET_PLAYERS?: string;
  BOT_SKILL?: string;
}

const ROOM_PATTERN = /^[a-z0-9_-]{1,32}$/i;

function roomNameFrom(url: URL): string {
  const raw = url.searchParams.get('room') ?? 'lobby';
  return ROOM_PATTERN.test(raw) ? raw.toLowerCase() : 'lobby';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomNameFrom(url)));
      return stub.fetch(request);
    }

    if (url.pathname === '/api/status') {
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomNameFrom(url)));
      const response = await stub.fetch(new Request('https://room/status'));
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { GameRoom };
