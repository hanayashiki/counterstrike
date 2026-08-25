/**
 * End-to-end smoke test against a running server (`npm run dev:worker`).
 *
 * This drives a headless client through the real binary protocol AND the real
 * client-side prediction code, so it validates three things at once:
 *   1. the Durable Object is simulating and streaming snapshots,
 *   2. the bots are navigating and fighting,
 *   3. client prediction agrees with the server (the reconciliation error
 *      stays at quantization noise instead of drifting).
 *
 *   npx tsx scripts/smoke.ts [url] [seconds]
 */
import { WebSocket } from 'ws';

import { LocalPlayer } from '../src/client/prediction';
import { BinaryReader } from '../src/shared/binary';
import { BTN_ATTACK, BTN_FORWARD, TICK_RATE } from '../src/shared/config';
import { GAME_MAP } from '../src/shared/map';
import {
  EventKind,
  MsgType,
  type PlayerInfo,
  decodeMatchState,
  decodePlayerInfo,
  decodeWelcome,
  encodeInputBatch,
  encodeJoin,
  encodePing,
  readSnapshot,
} from '../src/shared/protocol';
import { WeaponId } from '../src/shared/weapons';

const url = process.argv[2] ?? 'ws://127.0.0.1:8787/ws?room=smoke';
const seconds = Number(process.argv[3] ?? 8);

const TICK_MS = 1000 / TICK_RATE;
const STEP_INTERVAL_MS = 8;

/** `EventKind` is a const enum, so it has no runtime reverse mapping. */
const EVENT_NAMES: Record<number, string> = {
  [EventKind.Shot]: 'shot',
  [EventKind.Impact]: 'impact',
  [EventKind.Hit]: 'hit',
  [EventKind.Kill]: 'kill',
  [EventKind.Spawn]: 'spawn',
  [EventKind.TookDamage]: 'damage',
  [EventKind.Reload]: 'reload',
};
const eventName = (kind: number): string => EVENT_NAMES[kind] ?? String(kind);

const roster = new Map<number, PlayerInfo>();
const seenEvents = new Map<number, number>();
const movement = new Map<number, { x: number; z: number; travelled: number }>();

let welcomeId = 0;
let snapshots = 0;
let entityTotal = 0;
let maxTick = 0;
let matchStates = 0;
let lastError: string | null = null;

// Prediction accuracy tracking.
let correctionSum = 0;
let correctionMax = 0;
let correctionSamples = 0;
let distanceWalked = 0;

const local = new LocalPlayer(GAME_MAP.brushes, {
  onLocalShot: () => {},
  onLocalReloadStart: () => {},
  onLocalReloadEnd: () => {},
  onDryFire: () => {},
  onRecoil: () => {},
});

const socket = new WebSocket(url);
socket.binaryType = 'arraybuffer';

const failAfter = setTimeout(
  () => {
    lastError = 'timed out waiting for the server';
    finish();
  },
  (seconds + 10) * 1000,
);

socket.on('error', (error: Error) => {
  lastError = error.message;
  finish();
});

socket.on('open', () => {
  socket.send(encodeJoin('smoke-bot', -1, WeaponId.Rifle));
  socket.send(encodePing(Date.now() >>> 0, 0));

  const started = Date.now();
  let last = started;
  let accumulator = 0;
  let remainder = 0;
  let previousX = 0;
  let previousZ = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    accumulator += now - last;
    last = now;
    const elapsed = now - started;
    if (elapsed > seconds * 1000) {
      clearInterval(timer);
      finish();
      return;
    }

    let produced = false;
    let guard = 6;
    while (accumulator >= TICK_MS && guard-- > 0) {
      accumulator -= TICK_MS;
      remainder += TICK_MS;
      const dtMs = Math.max(1, Math.floor(remainder));
      remainder -= dtMs;

      // Walk forward while sweeping the view, and hold the trigger after the
      // first second so the server has to run the whole combat path.
      local.step(
        {
          buttons: BTN_FORWARD | (elapsed > 1200 ? BTN_ATTACK : 0),
          yaw: Math.sin(elapsed / 900) * 1.9,
          pitch: Math.sin(elapsed / 1700) * 0.15,
          moveX: 0,
          moveZ: 1,
        },
        dtMs,
      );
      produced = true;
    }

    if (produced) {
      socket.send(encodeInputBatch(local.unacked(4)));
      distanceWalked += Math.hypot(local.state.pos.x - previousX, local.state.pos.z - previousZ);
      previousX = local.state.pos.x;
      previousZ = local.state.pos.z;
    }
  }, STEP_INTERVAL_MS);
});

socket.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
  const reader = new BinaryReader(bytes);
  const type = reader.u8() as MsgType;

  switch (type) {
    case MsgType.Welcome: {
      welcomeId = decodeWelcome(reader).yourId;
      return;
    }
    case MsgType.PlayerInfo: {
      const info = decodePlayerInfo(reader);
      roster.set(info.id, info);
      return;
    }
    case MsgType.MatchState: {
      decodeMatchState(reader);
      matchStates++;
      return;
    }
    case MsgType.Snapshot: {
      const snapshot = readSnapshot(reader);
      snapshots++;
      maxTick = Math.max(maxTick, snapshot.tick);
      entityTotal += snapshot.entities.length;

      const beforeX = local.state.pos.x;
      const beforeY = local.state.pos.y;
      const beforeZ = local.state.pos.z;
      const wasAlive = local.alive;
      local.reconcile(snapshot.local, snapshot.ackSeq);

      // Only measure while we stayed alive: a respawn legitimately teleports us.
      if (wasAlive && local.alive && snapshot.ackSeq > 0) {
        const correction = Math.hypot(
          beforeX - local.state.pos.x,
          beforeY - local.state.pos.y,
          beforeZ - local.state.pos.z,
        );
        correctionSum += correction;
        correctionMax = Math.max(correctionMax, correction);
        correctionSamples++;
      }

      for (const entity of snapshot.entities) {
        const previous = movement.get(entity.id);
        if (previous) {
          previous.travelled += Math.hypot(entity.x - previous.x, entity.z - previous.z);
          previous.x = entity.x;
          previous.z = entity.z;
        } else {
          movement.set(entity.id, { x: entity.x, z: entity.z, travelled: 0 });
        }
      }
      for (const event of snapshot.events) {
        seenEvents.set(event.kind, (seenEvents.get(event.kind) ?? 0) + 1);
      }
      return;
    }
    default:
      return;
  }
});

function finish(): void {
  clearTimeout(failAfter);
  try {
    socket.close();
  } catch {
    // already closing
  }

  const bots = [...roster.values()].filter((p) => p.isBot);
  const moved = [...movement.values()].filter((m) => m.travelled > 2).length;
  const meanCorrection = correctionSamples > 0 ? correctionSum / correctionSamples : 0;

  console.log('--- smoke test ---');
  console.log(`url                 ${url}`);
  console.log(`my id               ${welcomeId}`);
  console.log(`roster              ${roster.size} (${bots.length} bots)`);
  console.log(`snapshots           ${snapshots} over ~${seconds}s`);
  console.log(`server tick         ${maxTick}`);
  console.log(`avg entities/snap   ${snapshots ? (entityTotal / snapshots).toFixed(1) : '0'}`);
  console.log(`bots that moved     ${moved}`);
  console.log(`match states        ${matchStates}`);
  console.log(`distance walked     ${distanceWalked.toFixed(1)} m`);
  console.log(
    `prediction error    mean ${(meanCorrection * 100).toFixed(2)} cm, max ${(correctionMax * 100).toFixed(2)} cm (n=${correctionSamples})`,
  );
  console.log(
    `events              ${[...seenEvents].map(([k, v]) => `${eventName(k)}=${v}`).join(' ') || 'none'}`,
  );

  const problems: string[] = [];
  if (lastError) problems.push(lastError);
  if (welcomeId === 0) problems.push('never received a Welcome');
  if (snapshots < seconds * 10) problems.push(`too few snapshots (${snapshots})`);
  if (bots.length < 4) problems.push(`expected the room to fill with bots, saw ${bots.length}`);
  if (moved < 3) problems.push(`bots are not navigating (${moved} moved)`);
  if (!seenEvents.has(EventKind.Shot)) problems.push('no shots were fired');
  if (distanceWalked < 5)
    problems.push(`local player barely moved (${distanceWalked.toFixed(1)} m)`);
  if (correctionSamples < 10) problems.push('not enough prediction samples');
  if (meanCorrection > 0.05) {
    problems.push(
      `prediction is drifting: mean correction ${(meanCorrection * 100).toFixed(1)} cm`,
    );
  }

  if (problems.length > 0) {
    console.error('\nFAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nPASS');
  process.exit(0);
}
