import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BinaryReader, BinaryWriter } from '../src/shared/binary';
import {
  EventKind,
  type GameEvent,
  type InputCommand,
  MatchPhase,
  MsgType,
  PF_ALIVE,
  PF_BOT,
  PF_CROUCH,
  PROTOCOL_VERSION,
  type Snapshot,
  decodeInputBatch,
  decodeJoin,
  decodeMatchState,
  decodePing,
  decodePlayerInfo,
  decodePong,
  decodeWelcome,
  encodeInputBatch,
  encodeJoin,
  encodeMatchState,
  encodePing,
  encodePlayerInfo,
  encodePong,
  encodeWelcome,
  readSnapshot,
  writeSnapshot,
} from '../src/shared/protocol';

const readerFor = (bytes: Uint8Array, expected: MsgType): BinaryReader => {
  const r = new BinaryReader(bytes);
  assert.equal(r.u8(), expected);
  return r;
};

test('join roundtrips and truncates over-long names', () => {
  const r = readerFor(encodeJoin('a'.repeat(60), 1, 2), MsgType.Join);
  const join = decodeJoin(r);
  assert.equal(join.version, PROTOCOL_VERSION);
  assert.equal(join.name.length, 24);
  assert.equal(join.team, 1);
  assert.equal(join.weapon, 2);
});

test('join preserves an auto-team request', () => {
  const join = decodeJoin(readerFor(encodeJoin('x', -1, 0), MsgType.Join));
  assert.equal(join.team, -1);
});

test('input batches survive the round trip', () => {
  const commands: InputCommand[] = [
    { seq: 1, dtMs: 16, buttons: 0b1010101, yaw: 1.2, pitch: -0.4, moveX: 1, moveZ: -1 },
    { seq: 2, dtMs: 15, buttons: 0, yaw: -3.0, pitch: 0, moveX: 0, moveZ: 0 },
    { seq: 3, dtMs: 50, buttons: 1 << 9, yaw: 0, pitch: 1.5, moveX: -0.5, moveZ: 0.25 },
  ];
  const decoded = decodeInputBatch(readerFor(encodeInputBatch(commands), MsgType.Input));
  assert.equal(decoded.length, 3);
  for (const [i, original] of commands.entries()) {
    const round = decoded[i] as InputCommand;
    assert.equal(round.seq, original.seq);
    assert.equal(round.dtMs, original.dtMs);
    assert.equal(round.buttons, original.buttons);
    assert.ok(Math.abs(round.yaw - original.yaw) < 0.001);
    assert.ok(Math.abs(round.pitch - original.pitch) < 0.001);
    assert.ok(Math.abs(round.moveX - original.moveX) < 0.01);
    assert.ok(Math.abs(round.moveZ - original.moveZ) < 0.01);
  }
});

test('welcome, player info, match state and ping/pong all roundtrip', () => {
  const welcome = decodeWelcome(
    readerFor(
      encodeWelcome({
        yourId: 42,
        tickRate: 64,
        snapshotRate: 32,
        mapName: 'cs_grid',
        serverTimeMs: 123456,
      }),
      MsgType.Welcome,
    ),
  );
  assert.deepEqual(welcome, {
    yourId: 42,
    tickRate: 64,
    snapshotRate: 32,
    mapName: 'cs_grid',
    serverTimeMs: 123456,
  });

  const info = decodePlayerInfo(
    readerFor(
      encodePlayerInfo({
        id: 7,
        name: 'Ghost',
        team: 1,
        isBot: true,
        kills: 12,
        deaths: 4,
        assists: 3,
        score: -5,
        pingMs: 84,
      }),
      MsgType.PlayerInfo,
    ),
  );
  assert.equal(info.name, 'Ghost');
  assert.equal(info.isBot, true);
  assert.equal(info.score, -5, 'negative scores must survive as signed');

  const match = decodeMatchState(
    readerFor(
      encodeMatchState({
        phase: MatchPhase.RoundEnd,
        timeLeftMs: 5500,
        scoreRed: 31,
        scoreBlue: 29,
        round: 3,
        mvp: 9,
      }),
      MsgType.MatchState,
    ),
  );
  assert.equal(match.phase, MatchPhase.RoundEnd);
  assert.equal(match.timeLeftMs, 5500);

  const ping = decodePing(readerFor(encodePing(999, 73), MsgType.Ping));
  assert.deepEqual(ping, { clientTimeMs: 999, measuredRttMs: 73 });

  const pong = decodePong(readerFor(encodePong(999, 4242), MsgType.Pong));
  assert.deepEqual(pong, { clientTimeMs: 999, serverTimeMs: 4242 });
});

test('a full snapshot with every event kind roundtrips', () => {
  const events: GameEvent[] = [
    {
      kind: EventKind.Shot,
      shooter: 3,
      weapon: 2,
      ox: 1.5,
      oy: 1.7,
      oz: -4.25,
      ex: 20.5,
      ey: 1.1,
      ez: -18.75,
    },
    { kind: EventKind.Impact, x: 5, y: 2, z: -3, nx: 0, ny: 1, nz: 0 },
    { kind: EventKind.Hit, attacker: 3, target: 8, x: 1, y: 2, z: 3, zone: 1, damage: 136 },
    { kind: EventKind.Kill, killer: 3, victim: 8, weapon: 2, headshot: true },
    { kind: EventKind.Spawn, id: 8, x: -4, y: 0.05, z: 31.5 },
    { kind: EventKind.TookDamage, attacker: 3, amount: 47, dirYaw: -2.1 },
    { kind: EventKind.Reload, id: 5 },
  ];

  const snapshot: Snapshot = {
    tick: 12345,
    serverTimeMs: 192_000,
    ackSeq: 987,
    local: {
      x: -12.5,
      y: 0.02,
      z: 8.75,
      vx: 3.5,
      vy: -9.25,
      vz: -1.125,
      yaw: 2.4,
      pitch: -0.8,
      flags: PF_ALIVE | PF_CROUCH,
      health: 73,
      armor: 22,
      weapon: 2,
      ammo: 17,
      reserve: 60,
      reloadMs: 1200,
      spread: 340,
      height: 1.15,
    },
    entities: [
      {
        id: 8,
        x: 3.25,
        y: 2,
        z: -9.5,
        yaw: -1.1,
        pitch: 0.2,
        flags: PF_ALIVE | PF_BOT,
        health: 100,
        weapon: 1,
        heightCm: 180,
      },
      {
        id: 9,
        x: -20,
        y: 0,
        z: 14,
        yaw: 3.0,
        pitch: -0.5,
        flags: 0,
        health: 0,
        weapon: 3,
        heightCm: 115,
      },
    ],
    events,
  };

  const w = new BinaryWriter(64);
  writeSnapshot(w, snapshot);
  const decoded = readSnapshot(readerFor(w.finish(), MsgType.Snapshot));

  assert.equal(decoded.tick, snapshot.tick);
  assert.equal(decoded.serverTimeMs, snapshot.serverTimeMs);
  assert.equal(decoded.ackSeq, snapshot.ackSeq);
  assert.equal(decoded.local.health, 73);
  assert.equal(decoded.local.ammo, 17);
  assert.equal(decoded.local.flags, PF_ALIVE | PF_CROUCH);
  assert.ok(Math.abs(decoded.local.x - snapshot.local.x) < 0.002);
  assert.ok(Math.abs(decoded.local.vz - snapshot.local.vz) < 0.02);
  assert.ok(Math.abs(decoded.local.height - 1.15) < 0.006);

  assert.equal(decoded.entities.length, 2);
  assert.equal(decoded.entities[0]?.id, 8);
  assert.equal(decoded.entities[1]?.heightCm, 115);

  assert.equal(decoded.events.length, events.length);
  for (const [i, original] of events.entries()) {
    assert.equal(decoded.events[i]?.kind, original.kind);
  }
  const kill = decoded.events[3];
  assert.ok(kill?.kind === EventKind.Kill && kill.headshot === true);
  const hit = decoded.events[2];
  assert.ok(hit?.kind === EventKind.Hit && hit.damage === 136);
  const impact = decoded.events[1];
  assert.ok(impact?.kind === EventKind.Impact && Math.abs(impact.ny - 1) < 0.01);
});

test('an empty snapshot encodes and decodes cleanly', () => {
  const snapshot: Snapshot = {
    tick: 0,
    serverTimeMs: 0,
    ackSeq: 0,
    local: {
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      flags: 0,
      health: 0,
      armor: 0,
      weapon: 0,
      ammo: 0,
      reserve: 0,
      reloadMs: 0,
      spread: 0,
      height: 1.8,
    },
    entities: [],
    events: [],
  };
  const w = new BinaryWriter(16);
  writeSnapshot(w, snapshot);
  const decoded = readSnapshot(readerFor(w.finish(), MsgType.Snapshot));
  assert.equal(decoded.entities.length, 0);
  assert.equal(decoded.events.length, 0);
});

test('snapshots stay small enough for a 32 Hz stream', () => {
  const snapshot: Snapshot = {
    tick: 1,
    serverTimeMs: 1,
    ackSeq: 1,
    local: {
      x: 1,
      y: 1,
      z: 1,
      vx: 1,
      vy: 1,
      vz: 1,
      yaw: 1,
      pitch: 1,
      flags: 1,
      health: 100,
      armor: 100,
      weapon: 2,
      ammo: 30,
      reserve: 90,
      reloadMs: 0,
      spread: 30,
      height: 1.8,
    },
    entities: Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      x: i,
      y: 0,
      z: i,
      yaw: 0,
      pitch: 0,
      flags: PF_ALIVE,
      health: 100,
      weapon: 2,
      heightCm: 180,
    })),
    events: [],
  };
  const w = new BinaryWriter(16);
  writeSnapshot(w, snapshot);
  // 15 other players plus the local state; JSON of the same data is ~10x this.
  assert.ok(w.length < 400, `snapshot was ${w.length} bytes`);
});
