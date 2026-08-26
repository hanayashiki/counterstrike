/**
 * `GameRoom` is a Durable Object: one instance per match, addressed by room
 * name. Because a DO is single-threaded and strongly consistent, it can hold
 * the authoritative world in plain memory and step it on a timer - no locking,
 * no cross-instance synchronisation, and every WebSocket for a match lands on
 * the same object.
 *
 * The object steps the world while at least one player is connected. When the
 * last one leaves the match freezes in place - not simulated, just held - and
 * is discarded after IDLE_SHUTDOWN_MS so the runtime can evict us. Reconnect
 * inside that window and you resume the same scoreline; after it, the next
 * connection rebuilds the match from scratch.
 */
import { createBot } from '../game/bot';
import { type BotSkill, GameWorld, TICK_MS, emptySnapshot } from '../game/world';
import { BinaryReader, BinaryWriter, type Bytes } from '../shared/binary';
import {
  MAX_PLAYERS,
  MAX_REWIND_MS,
  SNAPSHOT_RATE,
  TICK_RATE,
  botSkillFromIndex,
} from '../shared/config';
import {
  MsgType,
  PROTOCOL_VERSION,
  type Snapshot,
  decodeInputBatch,
  decodeJoin,
  decodePing,
  encodeChatBroadcast,
  encodeKick,
  encodeMatchState,
  encodePlayerInfo,
  encodePlayerLeft,
  encodePong,
  encodeWelcome,
  writeSnapshot,
} from '../shared/protocol';
import { WEAPON_COUNT, WeaponId } from '../shared/weapons';
import type { Env } from './index';

interface Session {
  ws: WebSocket;
  playerId: number;
  joined: boolean;
  /** Tick of the last snapshot serialized for this session. */
  lastSnapshotTick: number;
}

const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;
/** How often the timer callback runs; each callback may step several ticks. */
const LOOP_INTERVAL_MS = 8;
/** Cap on catch-up ticks per callback so a slow frame cannot snowball. */
const MAX_TICKS_PER_CALLBACK = 5;
/**
 * How long a match is held in memory after the last player leaves. The world is
 * frozen for this long rather than simulated, so a quick reconnect resumes the
 * exact scoreline instead of rejoining a match that drifted without them.
 */
const IDLE_SHUTDOWN_MS = 15_000;

const VALID_SKILLS = new Set<string>(['easy', 'normal', 'hard', 'elite']);

/** Drop C0/C1 control characters from chat without a control-char regex. */
function sanitizeText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.trim();
}

function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class GameRoom implements DurableObject {
  private world: GameWorld | null = null;
  private readonly sessions = new Map<WebSocket, Session>();
  private loop: ReturnType<typeof setInterval> | null = null;

  private accumulatorMs = 0;
  private snapshotAccumulatorMs = 0;
  private lastWallClockMs = 0;
  private emptySinceMs = 0;

  private readonly writer = new BinaryWriter(8192);
  private readonly snapshot: Snapshot = emptySnapshot();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/status')) {
      return Response.json(this.status());
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const world = this.ensureWorld();
    if (world.humanCount >= MAX_PLAYERS) {
      return new Response('room full', { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Deliberately not using hibernation: the match needs a continuously
    // running tick loop, and hibernating would discard the in-memory world.
    server.accept();
    // Without this the runtime hands us a Blob per frame, which would force an
    // async read on the hot path.
    server.binaryType = 'arraybuffer';

    const session: Session = { ws: server, playerId: 0, joined: false, lastSnapshotTick: -1 };
    this.sessions.set(server, session);

    server.addEventListener('message', (event: MessageEvent) => {
      try {
        this.onMessage(session, event.data);
      } catch (error) {
        console.error('message handling failed', error);
      }
    });
    server.addEventListener('close', () => this.dropSession(session));
    server.addEventListener('error', () => this.dropSession(session));

    this.startLoop();
    return new Response(null, { status: 101, webSocket: client });
  }

  private status(): Record<string, unknown> {
    const world = this.world;
    if (!world) return { active: false, players: [] };
    return {
      active: true,
      map: world.map.name,
      tick: world.tick,
      round: world.round,
      phase: world.phase,
      scoreRed: world.scoreRed,
      scoreBlue: world.scoreBlue,
      humans: world.humanCount,
      navNodes: world.nav.nodes.length,
      players: [...world.combatants.values()]
        .map((c) => world.playerInfo(c))
        .toSorted((a, b) => b.score - a.score),
    };
  }

  // -------------------------------------------------------------------------
  // World lifecycle
  // -------------------------------------------------------------------------

  private ensureWorld(): GameWorld {
    if (this.world) return this.world;

    const rawSkill = String(this.env.BOT_SKILL ?? 'normal') as BotSkill;
    const botSkill: BotSkill = VALID_SKILLS.has(rawSkill) ? rawSkill : 'normal';
    const targetPlayers = Number(this.env.TARGET_PLAYERS ?? 10) || 10;

    const world = new GameWorld({
      targetPlayers,
      botSkill,
      seed: hashString(this.ctx.id.toString()) ^ 0x5f3759df,
    });
    world.setBotFactory(createBot);
    world.balanceBots();
    this.world = world;
    return world;
  }

  private startLoop(): void {
    if (this.loop !== null) return;
    this.lastWallClockMs = Date.now();
    this.accumulatorMs = 0;
    this.snapshotAccumulatorMs = 0;
    this.emptySinceMs = 0;
    this.loop = setInterval(() => {
      try {
        this.onTimer();
      } catch (error) {
        console.error('tick failed', error);
      }
    }, LOOP_INTERVAL_MS);
  }

  private stopLoop(): void {
    if (this.loop === null) return;
    clearInterval(this.loop);
    this.loop = null;
    this.world = null;
  }

  private onTimer(): void {
    const world = this.world;
    if (!world) {
      this.stopLoop();
      return;
    }

    // Workers pin `Date.now()` between I/O events, but a timer callback counts
    // as one, so elapsed time does advance here. The fallback keeps the loop
    // running even if two callbacks ever observe the same instant.
    const now = Date.now();

    if (this.sessions.size === 0) {
      // Nobody is watching. Freeze the match rather than simulating it: the
      // bots would otherwise fight on at full tick rate for the whole grace
      // window, burning CPU on a game with no observers.
      if (this.emptySinceMs === 0) this.emptySinceMs = now;
      else if (now - this.emptySinceMs > IDLE_SHUTDOWN_MS) this.stopLoop();
      this.lastWallClockMs = now;
      this.accumulatorMs = 0;
      return;
    }

    if (this.emptySinceMs !== 0) {
      // Someone reconnected inside the grace window. Pick up where we stopped
      // instead of fast-forwarding through the frozen time.
      this.emptySinceMs = 0;
      this.lastWallClockMs = now;
      this.accumulatorMs = 0;
      this.snapshotAccumulatorMs = 0;
    }

    let elapsed = now - this.lastWallClockMs;
    if (!(elapsed > 0)) elapsed = LOOP_INTERVAL_MS;
    this.lastWallClockMs = now;
    if (elapsed > 250) elapsed = 250;

    this.accumulatorMs += elapsed;
    let steps = 0;
    while (this.accumulatorMs >= TICK_MS && steps < MAX_TICKS_PER_CALLBACK) {
      this.accumulatorMs -= TICK_MS;
      world.step();
      steps++;
    }
    if (steps === MAX_TICKS_PER_CALLBACK) this.accumulatorMs = 0;

    if (steps > 0) {
      this.snapshotAccumulatorMs += steps * TICK_MS;
      if (this.snapshotAccumulatorMs >= SNAPSHOT_INTERVAL_MS) {
        this.snapshotAccumulatorMs %= SNAPSHOT_INTERVAL_MS;
        this.flushRoster(world);
        this.broadcastSnapshots(world);
        world.clearEvents();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private send(session: Session, data: Bytes): void {
    try {
      session.ws.send(data);
    } catch {
      this.dropSession(session);
    }
  }

  private broadcast(data: Bytes): void {
    for (const session of this.sessions.values()) {
      if (session.joined) this.send(session, data);
    }
  }

  private flushRoster(world: GameWorld): void {
    // Departures first: a client that still has a stale id would otherwise
    // render one more PlayerInfo update for someone who already left.
    if (world.departed.length > 0) {
      for (const id of world.departed) this.broadcast(encodePlayerLeft(id));
      world.departed.length = 0;
    }
    if (world.dirtyRoster.size > 0) {
      for (const id of world.dirtyRoster) {
        const combatant = world.combatants.get(id);
        if (!combatant) continue;
        this.broadcast(encodePlayerInfo(world.playerInfo(combatant)));
      }
      world.dirtyRoster.clear();
    }
    if (world.matchStateDirty) {
      world.matchStateDirty = false;
      this.broadcast(encodeMatchState(world.matchState()));
    }
  }

  private broadcastSnapshots(world: GameWorld): void {
    for (const session of this.sessions.values()) {
      if (!session.joined) continue;
      world.buildSnapshot(session.playerId, this.snapshot);
      this.writer.reset();
      writeSnapshot(this.writer, this.snapshot);
      this.send(session, this.writer.finish());
      session.lastSnapshotTick = world.tick;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onMessage(session: Session, raw: unknown): void {
    // Text frames are not part of the protocol, and neither is anything that is
    // not a plain binary buffer.
    if (!(raw instanceof ArrayBuffer)) return;
    if (raw.byteLength === 0) return;
    const data = new Uint8Array(raw);

    const world = this.ensureWorld();
    const reader = new BinaryReader(data);
    const type = reader.u8() as MsgType;

    switch (type) {
      case MsgType.Join: {
        if (session.joined) return;
        const join = decodeJoin(reader);
        if (join.version !== PROTOCOL_VERSION) {
          this.send(
            session,
            encodeKick(`protocol mismatch: server ${PROTOCOL_VERSION}, client ${join.version}`),
          );
          session.ws.close(1002, 'protocol mismatch');
          return;
        }
        const weapon =
          join.weapon >= 0 && join.weapon < WEAPON_COUNT ? join.weapon : WeaponId.Rifle;
        const combatant = world.addPlayer(sanitizeText(join.name), false, join.team, weapon);
        session.playerId = combatant.id;
        session.joined = true;
        world.balanceBots();

        this.send(
          session,
          encodeWelcome({
            yourId: combatant.id,
            tickRate: TICK_RATE,
            snapshotRate: SNAPSHOT_RATE,
            mapName: world.map.name,
            serverTimeMs: Math.round(world.timeMs),
          }),
        );
        for (const other of world.combatants.values()) {
          this.send(session, encodePlayerInfo(world.playerInfo(other)));
        }
        this.send(session, encodeMatchState(world.matchState()));
        this.broadcast(encodePlayerInfo(world.playerInfo(combatant)));
        this.startLoop();
        return;
      }

      case MsgType.Input: {
        if (!session.joined) return;
        world.queueInput(session.playerId, decodeInputBatch(reader));
        return;
      }

      case MsgType.SelectWeapon: {
        if (!session.joined) return;
        const slot = reader.u8();
        const combatant = world.combatants.get(session.playerId);
        if (combatant && (slot === 0 || slot === 1) && !combatant.reloading) {
          combatant.activeSlot = slot;
          combatant.spread = 0;
        }
        return;
      }

      case MsgType.RequestRespawn: {
        if (!session.joined) return;
        const combatant = world.combatants.get(session.playerId);
        if (combatant && !combatant.alive && combatant.respawnAtMs > 0) {
          if (world.timeMs >= combatant.respawnAtMs) world.respawn(combatant);
        }
        return;
      }

      case MsgType.SetTeam: {
        if (!session.joined) return;
        const team = reader.u8();
        const combatant = world.combatants.get(session.playerId);
        if (combatant && (team === 0 || team === 1) && combatant.team !== team) {
          combatant.team = team;
          world.respawn(combatant, true);
          world.dirtyRoster.add(combatant.id);
          world.balanceBots();
        }
        return;
      }

      case MsgType.SetBotSkill: {
        if (!session.joined) return;
        const skill = botSkillFromIndex(reader.u8());
        if (world.setBotSkill(skill)) {
          const who = world.combatants.get(session.playerId);
          this.broadcast(encodeChatBroadcast(0, `${who?.name ?? 'someone'} set bots to ${skill}`));
        }
        return;
      }

      case MsgType.Ping: {
        const ping = decodePing(reader);
        const combatant = world.combatants.get(session.playerId);
        if (combatant) {
          combatant.pingMs = Math.min(MAX_REWIND_MS * 2, ping.measuredRttMs);
        }
        this.send(session, encodePong(ping.clientTimeMs, Math.round(world.timeMs)));
        return;
      }

      case MsgType.Chat: {
        if (!session.joined) return;
        const text = sanitizeText(reader.string().slice(0, 120));
        if (text.length > 0) this.broadcast(encodeChatBroadcast(session.playerId, text));
        return;
      }

      default:
        return;
    }
  }

  private dropSession(session: Session): void {
    if (!this.sessions.delete(session.ws)) return;
    if (session.joined && this.world) {
      // `removePlayer` queues the departure; the next flush announces it along
      // with any bots that balancing removed to make room.
      this.world.removePlayer(session.playerId);
      this.world.balanceBots();
    }
    try {
      session.ws.close(1000, 'bye');
    } catch {
      // already closed
    }
  }
}
