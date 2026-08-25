/**
 * Wire protocol. Every message is a binary frame whose first byte is a
 * `MsgType`. Client -> server traffic is tiny (input batches); server -> client
 * is dominated by snapshots, which are delta-free but heavily quantized.
 */
import { type BinaryReader, BinaryWriter, type Bytes } from './binary';
import type { TeamId } from './map';

export const PROTOCOL_VERSION = 3;

export const enum MsgType {
  // client -> server
  Join = 1,
  Input = 2,
  SelectWeapon = 3,
  Chat = 4,
  RequestRespawn = 5,
  Ping = 6,
  SetTeam = 7,

  // server -> client
  Welcome = 64,
  Snapshot = 65,
  PlayerInfo = 66,
  PlayerLeft = 67,
  MatchState = 68,
  Pong = 69,
  ChatBroadcast = 70,
  Kick = 71,
}

export const enum EventKind {
  Shot = 0,
  Impact = 1,
  Hit = 2,
  Kill = 3,
  Spawn = 4,
  TookDamage = 5,
  Reload = 6,
}

export const enum MatchPhase {
  Warmup = 0,
  Live = 1,
  RoundEnd = 2,
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface InputCommand {
  seq: number;
  /** Duration this command covers, in whole milliseconds. */
  dtMs: number;
  buttons: number;
  yaw: number;
  pitch: number;
  moveX: number;
  moveZ: number;
}

export const PF_ALIVE = 1 << 0;
export const PF_CROUCH = 1 << 1;
export const PF_FIRING = 1 << 2;
export const PF_RELOADING = 1 << 3;
export const PF_TEAM_BLUE = 1 << 4;
export const PF_BOT = 1 << 5;
export const PF_ON_GROUND = 1 << 6;
export const PF_ADS = 1 << 7;

export interface EntitySnapshot {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  health: number;
  weapon: number;
  /** Hull height in centimeters, so the client can render crouch poses. */
  heightCm: number;
}

export interface LocalSnapshot {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  flags: number;
  health: number;
  armor: number;
  weapon: number;
  ammo: number;
  reserve: number;
  reloadMs: number;
  /** Current spread cone half-angle * 10000. */
  spread: number;
  height: number;
}

export type GameEvent =
  | {
      kind: EventKind.Shot;
      shooter: number;
      weapon: number;
      ox: number;
      oy: number;
      oz: number;
      ex: number;
      ey: number;
      ez: number;
    }
  | { kind: EventKind.Impact; x: number; y: number; z: number; nx: number; ny: number; nz: number }
  | {
      kind: EventKind.Hit;
      attacker: number;
      target: number;
      x: number;
      y: number;
      z: number;
      zone: number;
      damage: number;
    }
  | { kind: EventKind.Kill; killer: number; victim: number; weapon: number; headshot: boolean }
  | { kind: EventKind.Spawn; id: number; x: number; y: number; z: number }
  | { kind: EventKind.TookDamage; attacker: number; amount: number; dirYaw: number }
  | { kind: EventKind.Reload; id: number };

export interface Snapshot {
  tick: number;
  serverTimeMs: number;
  ackSeq: number;
  local: LocalSnapshot;
  entities: EntitySnapshot[];
  events: GameEvent[];
}

export interface PlayerInfo {
  id: number;
  name: string;
  team: TeamId;
  isBot: boolean;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  pingMs: number;
}

export interface MatchStateMsg {
  phase: MatchPhase;
  timeLeftMs: number;
  scoreRed: number;
  scoreBlue: number;
  round: number;
  /** Player id that won the round MVP, or 0xffff for none. */
  mvp: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export function encodeJoin(name: string, team: number, weapon: number): Bytes {
  const w = new BinaryWriter(64);
  w.u8(MsgType.Join).u16(PROTOCOL_VERSION).string(name.slice(0, 24)).i8(team).u8(weapon);
  return w.finish();
}

export interface JoinMsg {
  version: number;
  name: string;
  team: number;
  weapon: number;
}

export function decodeJoin(r: BinaryReader): JoinMsg {
  return { version: r.u16(), name: r.string(), team: r.i8(), weapon: r.u8() };
}

const MOVE_SCALE = 127;

export function encodeInputBatch(commands: readonly InputCommand[]): Bytes {
  const w = new BinaryWriter(16 + commands.length * 12);
  w.u8(MsgType.Input);
  w.u8(Math.min(commands.length, 255));
  for (let i = 0; i < commands.length && i < 255; i++) {
    const c = commands[i] as InputCommand;
    w.u32(c.seq);
    w.u8(Math.min(255, Math.max(1, c.dtMs)));
    w.u16(c.buttons);
    w.yaw(c.yaw);
    w.pitch(c.pitch);
    w.i8(Math.round(c.moveX * MOVE_SCALE));
    w.i8(Math.round(c.moveZ * MOVE_SCALE));
  }
  return w.finish();
}

export function decodeInputBatch(r: BinaryReader): InputCommand[] {
  const count = r.u8();
  const out: InputCommand[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      seq: r.u32(),
      dtMs: r.u8(),
      buttons: r.u16(),
      yaw: r.yaw(),
      pitch: r.pitch(),
      moveX: r.i8() / MOVE_SCALE,
      moveZ: r.i8() / MOVE_SCALE,
    });
  }
  return out;
}

export function encodeSimple(type: MsgType, value = 0): Bytes {
  return new BinaryWriter(4).u8(type).u8(value).finish();
}

/**
 * Ping carries the client's clock plus the round-trip time it measured on the
 * previous exchange. The server sizes its lag-compensation rewind from that
 * RTT, clamped server-side so a lying client cannot rewind further than the
 * rules allow.
 */
export function encodePing(clientTimeMs: number, measuredRttMs: number): Bytes {
  return new BinaryWriter(8)
    .u8(MsgType.Ping)
    .u32(clientTimeMs >>> 0)
    .u16(Math.min(65535, Math.max(0, Math.round(measuredRttMs))))
    .finish();
}

export function decodePing(r: BinaryReader): { clientTimeMs: number; measuredRttMs: number } {
  return { clientTimeMs: r.u32(), measuredRttMs: r.u16() };
}

export function encodePong(clientTimeMs: number, serverTimeMs: number): Bytes {
  return new BinaryWriter(12)
    .u8(MsgType.Pong)
    .u32(clientTimeMs >>> 0)
    .u32(serverTimeMs >>> 0)
    .finish();
}

export function decodePong(r: BinaryReader): { clientTimeMs: number; serverTimeMs: number } {
  return { clientTimeMs: r.u32(), serverTimeMs: r.u32() };
}

export function encodeKick(reason: string): Bytes {
  return new BinaryWriter(96).u8(MsgType.Kick).string(reason).finish();
}

export function encodeChat(text: string): Bytes {
  return new BinaryWriter(160).u8(MsgType.Chat).string(text.slice(0, 120)).finish();
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  yourId: number;
  tickRate: number;
  snapshotRate: number;
  mapName: string;
  serverTimeMs: number;
}

export function encodeWelcome(m: WelcomeMsg): Bytes {
  const w = new BinaryWriter(64);
  w.u8(MsgType.Welcome)
    .u16(m.yourId)
    .u8(m.tickRate)
    .u8(m.snapshotRate)
    .string(m.mapName)
    .u32(m.serverTimeMs >>> 0);
  return w.finish();
}

export function decodeWelcome(r: BinaryReader): WelcomeMsg {
  return {
    yourId: r.u16(),
    tickRate: r.u8(),
    snapshotRate: r.u8(),
    mapName: r.string(),
    serverTimeMs: r.u32(),
  };
}

export function writeSnapshot(w: BinaryWriter, s: Snapshot): void {
  w.u8(MsgType.Snapshot);
  w.u32(s.tick);
  w.u32(s.serverTimeMs >>> 0);
  w.u32(s.ackSeq);

  const l = s.local;
  w.pos(l.x).pos(l.y).pos(l.z);
  w.vel(l.vx).vel(l.vy).vel(l.vz);
  w.yaw(l.yaw).pitch(l.pitch);
  w.u8(l.flags);
  w.u8(l.health).u8(l.armor).u8(l.weapon);
  w.u16(l.ammo).u16(l.reserve).u16(l.reloadMs).u16(l.spread);
  w.u16(Math.round(l.height * 100));

  w.u8(Math.min(255, s.entities.length));
  for (let i = 0; i < s.entities.length && i < 255; i++) {
    const e = s.entities[i] as EntitySnapshot;
    w.u16(e.id);
    w.pos(e.x).pos(e.y).pos(e.z);
    w.yaw(e.yaw).pitch(e.pitch);
    w.u8(e.flags).u8(e.health).u8(e.weapon).u8(Math.min(255, e.heightCm));
  }

  w.u8(Math.min(255, s.events.length));
  for (let i = 0; i < s.events.length && i < 255; i++) {
    writeEvent(w, s.events[i] as GameEvent);
  }
}

function writeEvent(w: BinaryWriter, e: GameEvent): void {
  w.u8(e.kind);
  switch (e.kind) {
    case EventKind.Shot:
      w.u16(e.shooter).u8(e.weapon);
      w.pos(e.ox).pos(e.oy).pos(e.oz);
      w.pos(e.ex).pos(e.ey).pos(e.ez);
      break;
    case EventKind.Impact:
      w.pos(e.x).pos(e.y).pos(e.z);
      w.i8(e.nx * 127)
        .i8(e.ny * 127)
        .i8(e.nz * 127);
      break;
    case EventKind.Hit:
      w.u16(e.attacker).u16(e.target);
      w.pos(e.x).pos(e.y).pos(e.z);
      w.u8(e.zone).u16(e.damage);
      break;
    case EventKind.Kill:
      w.u16(e.killer).u16(e.victim).u8(e.weapon).bool(e.headshot);
      break;
    case EventKind.Spawn:
      w.u16(e.id).pos(e.x).pos(e.y).pos(e.z);
      break;
    case EventKind.TookDamage:
      w.u16(e.attacker).u8(Math.min(255, e.amount)).yaw(e.dirYaw);
      break;
    case EventKind.Reload:
      w.u16(e.id);
      break;
  }
}

function readEvent(r: BinaryReader): GameEvent {
  const kind = r.u8() as EventKind;
  switch (kind) {
    case EventKind.Shot:
      return {
        kind,
        shooter: r.u16(),
        weapon: r.u8(),
        ox: r.pos(),
        oy: r.pos(),
        oz: r.pos(),
        ex: r.pos(),
        ey: r.pos(),
        ez: r.pos(),
      };
    case EventKind.Impact:
      return {
        kind,
        x: r.pos(),
        y: r.pos(),
        z: r.pos(),
        nx: r.i8() / 127,
        ny: r.i8() / 127,
        nz: r.i8() / 127,
      };
    case EventKind.Hit:
      return {
        kind,
        attacker: r.u16(),
        target: r.u16(),
        x: r.pos(),
        y: r.pos(),
        z: r.pos(),
        zone: r.u8(),
        damage: r.u16(),
      };
    case EventKind.Kill:
      return { kind, killer: r.u16(), victim: r.u16(), weapon: r.u8(), headshot: r.bool() };
    case EventKind.Spawn:
      return { kind, id: r.u16(), x: r.pos(), y: r.pos(), z: r.pos() };
    case EventKind.TookDamage:
      return { kind, attacker: r.u16(), amount: r.u8(), dirYaw: r.yaw() };
    case EventKind.Reload:
      return { kind, id: r.u16() };
    default:
      throw new Error(`unknown event kind ${kind}`);
  }
}

export function readSnapshot(r: BinaryReader): Snapshot {
  const tick = r.u32();
  const serverTimeMs = r.u32();
  const ackSeq = r.u32();

  const local: LocalSnapshot = {
    x: r.pos(),
    y: r.pos(),
    z: r.pos(),
    vx: r.vel(),
    vy: r.vel(),
    vz: r.vel(),
    yaw: r.yaw(),
    pitch: r.pitch(),
    flags: r.u8(),
    health: r.u8(),
    armor: r.u8(),
    weapon: r.u8(),
    ammo: r.u16(),
    reserve: r.u16(),
    reloadMs: r.u16(),
    spread: r.u16(),
    height: r.u16() / 100,
  };

  const entityCount = r.u8();
  const entities: EntitySnapshot[] = [];
  for (let i = 0; i < entityCount; i++) {
    entities.push({
      id: r.u16(),
      x: r.pos(),
      y: r.pos(),
      z: r.pos(),
      yaw: r.yaw(),
      pitch: r.pitch(),
      flags: r.u8(),
      health: r.u8(),
      weapon: r.u8(),
      heightCm: r.u8(),
    });
  }

  const eventCount = r.u8();
  const events: GameEvent[] = [];
  for (let i = 0; i < eventCount; i++) events.push(readEvent(r));

  return { tick, serverTimeMs, ackSeq, local, entities, events };
}

export function encodePlayerInfo(p: PlayerInfo): Bytes {
  const w = new BinaryWriter(64);
  w.u8(MsgType.PlayerInfo)
    .u16(p.id)
    .string(p.name)
    .u8(p.team)
    .bool(p.isBot)
    .u16(p.kills)
    .u16(p.deaths)
    .u16(p.assists)
    .i32(p.score)
    .u16(Math.min(65535, p.pingMs));
  return w.finish();
}

export function decodePlayerInfo(r: BinaryReader): PlayerInfo {
  return {
    id: r.u16(),
    name: r.string(),
    team: r.u8() as TeamId,
    isBot: r.bool(),
    kills: r.u16(),
    deaths: r.u16(),
    assists: r.u16(),
    score: r.i32(),
    pingMs: r.u16(),
  };
}

export function encodeMatchState(m: MatchStateMsg): Bytes {
  const w = new BinaryWriter(24);
  w.u8(MsgType.MatchState)
    .u8(m.phase)
    .u32(Math.max(0, m.timeLeftMs))
    .u16(m.scoreRed)
    .u16(m.scoreBlue)
    .u16(m.round)
    .u16(m.mvp);
  return w.finish();
}

export function decodeMatchState(r: BinaryReader): MatchStateMsg {
  return {
    phase: r.u8() as MatchPhase,
    timeLeftMs: r.u32(),
    scoreRed: r.u16(),
    scoreBlue: r.u16(),
    round: r.u16(),
    mvp: r.u16(),
  };
}

export function encodeChatBroadcast(fromId: number, text: string): Bytes {
  return new BinaryWriter(160).u8(MsgType.ChatBroadcast).u16(fromId).string(text).finish();
}
