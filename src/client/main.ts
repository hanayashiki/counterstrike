/**
 * Client entry point: wires the menu, the network client, prediction, the
 * renderer and the HUD into one fixed-step game loop.
 *
 * Timing model
 *  - Input is sampled and simulated at a fixed 64 Hz so the commands we send
 *    line up exactly with the server's tick.
 *  - The local player is predicted immediately and reconciled on every
 *    snapshot.
 *  - Remote players are rendered `INTERP_DELAY_MS` in the past and interpolated
 *    between snapshots.
 */
import * as THREE from 'three';

import {
  BTN_ADS,
  EYE_OFFSET,
  LEAN_DISTANCE,
  LEAN_DROP,
  LEAN_ROLL,
  INTERP_DELAY_MS,
  RESPAWN_DELAY_MS,
  TICK_RATE,
} from '../shared/config';
import { GAME_MAP, TEAM_NAMES, type TeamId } from '../shared/map';
import { type Vec3, forwardFromAngles, vec3 } from '../shared/math';
import {
  EventKind,
  type GameEvent,
  MatchPhase,
  type MatchStateMsg,
  PF_ALIVE,
  type PlayerInfo,
  type Snapshot,
  type WelcomeMsg,
} from '../shared/protocol';
import { HitZone, WeaponId, getWeapon } from '../shared/weapons';
import { AudioEngine } from './audio';
import { Hud } from './hud';
import type { InputSnapshot } from './input';
import { InputController } from './input';
import { NetClient } from './net';
import { LocalPlayer } from './prediction';
import { EffectsSystem } from './render/effects';
import { PlayerManager } from './render/players';
import { DEFAULT_FOV, RenderContext } from './render/scene';
import { Viewmodel } from './render/viewmodel';
import { buildWorld } from './render/world';

const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;
/** Unacked commands resent with every packet, to ride out a lost frame. */
const INPUT_REDUNDANCY = 4;

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const menu = document.getElementById('menu') as HTMLElement;
const menuStatus = document.getElementById('menu-status') as HTMLElement;
const playButton = document.getElementById('menu-play') as HTMLButtonElement;
const nameField = document.getElementById('menu-name') as HTMLInputElement;
const roomField = document.getElementById('menu-room') as HTMLInputElement;

function wireChoices(containerId: string, initial: number): { value: number } {
  const container = document.getElementById(containerId) as HTMLElement;
  const state = { value: initial };
  for (const button of container.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      for (const other of container.querySelectorAll('button')) other.classList.remove('active');
      button.classList.add('active');
      state.value = Number(button.dataset.value);
    });
  }
  return state;
}

const teamChoice = wireChoices('menu-team', -1);
const weaponChoice = wireChoices('menu-weapon', WeaponId.Rifle);

/**
 * What each tier actually does, in terms a player can act on. Measured over a
 * headless ten-bot match, not adjectives.
 */
const SKILL_NOTES: readonly string[] = [
  'Slow to notice you, slow to swing, and shooting about three metres wide at twenty paces. ~14 kills/min.',
  'Reacts in a third of a second and sees you across half the map. ~37 kills/min.',
  'Quick, accurate, and picks heads almost half the time. ~43 kills/min.',
  'Near-instant reactions, sees the whole map, two thirds of its kills are headshots. ~57 kills/min.',
];

function serverUrl(room: string): string {
  const secure = globalThis.location.protocol === 'https:';
  const protocol = secure ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV
    ? `${globalThis.location.hostname}:${__GAME_SERVER_PORT__}`
    : globalThis.location.host;
  return `${protocol}//${host}/ws?room=${encodeURIComponent(room)}`;
}

class Game {
  private readonly ctx = new RenderContext(canvas);
  private readonly effects = new EffectsSystem(this.ctx.scene);
  private readonly players = new PlayerManager(this.ctx.scene);
  private readonly viewmodel = new Viewmodel(this.ctx.viewmodelScene);
  private readonly audio = new AudioEngine();
  private readonly hud: Hud;
  private readonly input: InputController;
  private readonly net: NetClient;
  private readonly local: LocalPlayer;

  private readonly roster = new Map<number, PlayerInfo>();
  private readonly aliveIds = new Set<number>();
  private myId = 0;
  private myTeam: TeamId = 0;

  private match: MatchStateMsg = {
    phase: MatchPhase.Warmup,
    timeLeftMs: 0,
    scoreRed: 0,
    scoreBlue: 0,
    round: 1,
    mvp: 0xffff,
    botSkill: 1,
  };
  private matchStateAt = 0;

  private running = false;
  private stepAccumulator = 0;
  private msRemainder = 0;
  private lastFrameMs = 0;
  private frameSamples: number[] = [];

  private deathAtMs = 0;
  private killerName: string | null = null;

  private lastYaw = 0;
  private lastPitch = 0;
  private landDip = 0;
  private wasOnGround = true;
  private bobPhase = 0;
  /** Input sampled once per frame and reused by camera, HUD and viewmodel. */
  private sample: InputSnapshot = { buttons: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0 };

  private readonly eye = vec3();
  private readonly forward = vec3();
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();

  constructor() {
    buildWorld(this.ctx.scene);

    this.hud = new Hud((text) => this.net.sendChat(text));

    this.net = new NetClient({
      onWelcome: (msg) => this.onWelcome(msg),
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
      onPlayerInfo: (info) => this.onPlayerInfo(info),
      onPlayerLeft: (id) => this.onPlayerLeft(id),
      onMatchState: (state) => this.onMatchState(state),
      onChat: (fromId, text) => this.onChat(fromId, text),
      onKick: (reason) => this.fail(reason),
      onClose: (reason) => this.fail(reason),
    });

    this.local = new LocalPlayer(GAME_MAP.brushes, {
      onLocalShot: (def) => this.onLocalShot(def.id),
      onLocalReloadStart: () => this.audio.reloadStart(),
      onLocalReloadEnd: () => this.audio.reloadEnd(),
      onDryFire: () => this.audio.dryFire(),
      onRecoil: (yaw, pitch) => this.input.applyRecoil(yaw, pitch),
    });

    this.input = new InputController(canvas, {
      onWeaponSlot: (slot) => this.net.selectWeapon(slot),
      onToggleScoreboard: (open) => {
        // The full scoreboard supersedes the compact roster; showing both is noise.
        this.hud.toggleScoreboard(open);
        this.hud.setRosterVisible(!open);
      },
      onOpenChat: () => {
        this.hud.openChat();
        this.input.setTextCapture(true);
        this.input.releaseLock();
      },
      onRespawnRequest: () => {
        if (!this.local.alive) this.net.requestRespawn();
      },
      onPointerLockChange: (locked) => {
        if (this.hud.chatOpen) return;
        this.input.setTextCapture(false);
        // Losing the mouse is the only moment settings can be changed, so it
        // doubles as the options screen rather than a bare "click to resume".
        if (this.running) this.setPaused(!locked);
      },
      onOpenOptions: () => {
        this.setPaused(true);
        this.input.releaseLock();
      },
    });

    canvas.addEventListener('click', () => {
      if (!this.running) return;
      if (this.hud.chatOpen) {
        this.hud.closeChat();
        this.input.setTextCapture(false);
      }
      if (!this.input.pointerLocked) this.input.requestLock();
    });

    this.wirePausePanel();
  }

  /** The in-game options panel: enemy skill and team, applied immediately. */
  private wirePausePanel(): void {
    const skills = document.getElementById('skill-choices') as HTMLElement;
    for (const button of skills.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.value);
        this.net.setBotSkill(index);
        // Reflect the choice at once; the server confirms via MatchState.
        this.hud.setPaused(true, index, SKILL_NOTES[index] ?? '');
      });
    }

    const teams = document.getElementById('team-choices') as HTMLElement;
    for (const button of teams.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        const team = Number(button.dataset.value) as TeamId;
        this.net.setTeam(team);
        this.hud.setPausedTeam(team);
      });
    }

    const resume = document.getElementById('resume') as HTMLButtonElement;
    resume.addEventListener('click', () => {
      this.setPaused(false);
      this.input.requestLock();
    });

    const overlay = document.getElementById('pause') as HTMLElement;
    overlay.addEventListener('click', (event) => {
      // Clicking the backdrop resumes; clicking inside the panel does not.
      if (event.target === overlay) {
        this.setPaused(false);
        this.input.requestLock();
      }
    });
  }

  private setPaused(paused: boolean): void {
    this.hud.setPaused(paused, this.match.botSkill, SKILL_NOTES[this.match.botSkill] ?? '');
    if (paused) this.hud.setPausedTeam(this.myTeam);
  }

  async start(name: string, room: string, team: number, weapon: number): Promise<void> {
    await this.audio.init();
    await this.net.connect(serverUrl(room), { name, team, weapon });
    this.running = true;
    this.lastFrameMs = performance.now();
    menu.classList.add('hidden');
    this.hud.show();
    this.input.requestLock();
    requestAnimationFrame(this.frame);
  }

  private fail(reason: string): void {
    if (!this.running) return;
    this.running = false;
    this.hud.hide();
    this.hud.toggleScoreboard(false);
    menu.classList.remove('hidden');
    menuStatus.textContent = reason;
    menuStatus.classList.add('error');
    playButton.disabled = false;
    playButton.textContent = 'Reconnect';
    this.players.clear();
    this.roster.clear();
    this.input.releaseLock();
  }

  // ------------------------------------------------------------------ network

  private onWelcome(msg: WelcomeMsg): void {
    this.myId = msg.yourId;
    this.local.reset();
    this.hud.addSystem(`Connected to ${msg.mapName} (${msg.tickRate} Hz)`);
  }

  private onPlayerInfo(info: PlayerInfo): void {
    this.roster.set(info.id, info);
    if (info.id === this.myId) this.myTeam = info.team;
  }

  private onPlayerLeft(id: number): void {
    const info = this.roster.get(id);
    if (info) this.hud.addSystem(`${info.name} left`);
    this.roster.delete(id);
    this.players.remove(id);
    this.aliveIds.delete(id);
  }

  private onMatchState(state: MatchStateMsg): void {
    const previousPhase = this.match.phase;
    this.match = state;
    this.matchStateAt = performance.now();
    this.hud.setScores(state.scoreRed, state.scoreBlue);
    if (this.hud.paused) {
      this.hud.setPaused(true, state.botSkill, SKILL_NOTES[state.botSkill] ?? '');
    }
    this.hud.setMatchState(state.phase, state.timeLeftMs, state.round);
    if (state.phase === MatchPhase.RoundEnd && previousPhase !== MatchPhase.RoundEnd) {
      const weWon =
        this.myTeam === 0 ? state.scoreRed > state.scoreBlue : state.scoreBlue > state.scoreRed;
      this.audio.roundEnd(weWon);
      const winner =
        state.scoreRed === state.scoreBlue ? null : state.scoreRed > state.scoreBlue ? 0 : 1;
      this.hud.banner(winner === null ? 'Draw' : `${TEAM_NAMES[winner as TeamId]} win`, 4000);
    }
  }

  private onChat(fromId: number, text: string): void {
    const info = this.roster.get(fromId);
    this.hud.addChat(info?.name ?? 'unknown', info?.team ?? 0, text);
  }

  private onSnapshot(snapshot: Snapshot): void {
    this.local.reconcile(snapshot.local, snapshot.ackSeq);
    this.players.ingest(snapshot.entities, snapshot.serverTimeMs);

    this.aliveIds.clear();
    if ((snapshot.local.flags & PF_ALIVE) !== 0) this.aliveIds.add(this.myId);
    for (const entity of snapshot.entities) {
      if ((entity.flags & PF_ALIVE) !== 0) this.aliveIds.add(entity.id);
    }

    for (const event of snapshot.events) this.handleEvent(event);

    this.hud.setVitals(snapshot.local.health, snapshot.local.armor, this.local.alive);
    this.hud.setWeapon(
      this.local.weaponId,
      this.local.ammo,
      this.local.reserve,
      this.local.reloading,
    );
  }

  private handleEvent(event: GameEvent): void {
    switch (event.kind) {
      case EventKind.Shot: {
        const def = getWeapon(event.weapon);
        const origin = { x: event.ox, y: event.oy, z: event.oz };
        const end = { x: event.ex, y: event.ey, z: event.ez };
        this.effects.spawnTracer(origin, end, def.tracerColor);
        if (event.shooter !== this.myId) {
          const direction = this.normalizedDelta(origin, end);
          this.effects.spawnMuzzleFlash(origin, direction);
          this.audio.gunshot(event.weapon, origin);
        }
        return;
      }

      case EventKind.Impact: {
        const point = { x: event.x, y: event.y, z: event.z };
        this.effects.spawnImpact(point, { x: event.nx, y: event.ny, z: event.nz });
        this.audio.impact(point);
        return;
      }

      case EventKind.Hit: {
        const point = { x: event.x, y: event.y, z: event.z };
        this.effects.spawnBlood(point, { x: 0, y: 1, z: 0 });
        if (event.attacker === this.myId) {
          this.hud.showHitmarker(false);
          this.audio.hitmarker(event.zone === HitZone.Head);
        }
        return;
      }

      case EventKind.Kill: {
        const killer = this.roster.get(event.killer);
        const victim = this.roster.get(event.victim);
        const involvesMe = event.killer === this.myId || event.victim === this.myId;
        this.hud.addKillfeed(
          killer?.name ?? 'world',
          killer?.team ?? 0,
          victim?.name ?? 'player',
          victim?.team ?? 0,
          event.weapon,
          event.headshot,
          involvesMe,
        );
        if (event.killer === this.myId && event.victim !== this.myId) {
          this.hud.showHitmarker(true);
          this.audio.kill();
        }
        if (event.victim === this.myId) {
          this.deathAtMs = performance.now();
          this.killerName = killer?.name ?? null;
          this.audio.death();
        }
        this.aliveIds.delete(event.victim);
        return;
      }

      case EventKind.Spawn: {
        if (event.id === this.myId) {
          this.deathAtMs = 0;
          this.killerName = null;
          this.local.reset();
          this.audio.spawn();
        }
        this.aliveIds.add(event.id);
        return;
      }

      case EventKind.TookDamage: {
        this.hud.showDamage(event.dirYaw, this.input.yaw);
        this.audio.hurt();
        return;
      }

      case EventKind.Reload:
        return;

      default:
        return;
    }
  }

  private normalizedDelta(from: Vec3, to: Vec3): Vec3 {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz) || 1;
    return { x: dx / length, y: dy / length, z: dz / length };
  }

  private onLocalShot(weaponId: number): void {
    // Predicted feedback: flash and report fire immediately, the authoritative
    // tracer arrives with the next snapshot.
    this.viewmodel.muzzleLocal(this.muzzleWorld);
    this.audio.gunshot(weaponId, undefined, 1);
    const def = getWeapon(weaponId);
    this.viewmodel.punch(def.recoilVertical);

    this.local.renderPosition(this.eye);
    this.eye.y += this.local.state.height - EYE_OFFSET;
    forwardFromAngles(this.forward, this.input.yaw, this.input.pitch);
    this.effects.spawnMuzzleFlash(
      {
        x: this.eye.x + this.forward.x * 0.55,
        y: this.eye.y + this.forward.y * 0.55 - 0.08,
        z: this.eye.z + this.forward.z * 0.55,
      },
      this.forward,
      0.7,
    );
  }

  // --------------------------------------------------------------------- loop

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const frameMs = Math.min(100, now - this.lastFrameMs);
    this.lastFrameMs = now;
    const dt = frameMs / 1000;
    this.sample = this.input.sample();

    this.simulate(frameMs);
    this.updateCamera(dt);
    this.players.update(this.net.serverNow(), dt);
    this.effects.update(dt);
    this.updateHud(now, frameMs);

    this.ctx.render();
  };

  private simulate(frameMs: number): void {
    this.stepAccumulator += frameMs;
    let steps = 0;
    let produced = false;

    while (this.stepAccumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.stepAccumulator -= TICK_MS;
      steps++;

      // Keep the millisecond-quantized command stream at exactly 64 Hz on
      // average by alternating 15 ms and 16 ms steps.
      this.msRemainder += TICK_MS;
      const dtMs = Math.max(1, Math.floor(this.msRemainder));
      this.msRemainder -= dtMs;

      this.local.step(this.sample, dtMs);
      produced = true;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.stepAccumulator = 0;
    if (produced) this.net.sendInputs(this.local.unacked(INPUT_REDUNDANCY));
  }

  private updateCamera(dt: number): void {
    const state = this.local.state;
    this.local.renderPosition(this.eye);

    const speed = Math.hypot(state.vel.x, state.vel.z);
    if (!this.wasOnGround && state.onGround) this.landDip = 0.09;
    this.wasOnGround = state.onGround;
    this.landDip *= Math.exp(-11 * dt);

    // Subtle head bob; it also drives the footstep sounds.
    if (state.onGround && speed > 0.6) {
      const previous = this.bobPhase;
      this.bobPhase += dt * (5.5 + speed * 1.1);
      if (Math.floor(previous / Math.PI) !== Math.floor(this.bobPhase / Math.PI)) {
        this.audio.footstep(speed);
      }
    }
    const bob = state.onGround ? Math.sin(this.bobPhase) * 0.014 * Math.min(1, speed / 7) : 0;

    // Lean slides the viewpoint sideways past the hull and rolls the horizon.
    // The server applies the identical offset when it traces our shots, so the
    // peek is real rather than cosmetic.
    const leanOffset = state.lean * LEAN_DISTANCE;
    const cosYaw = Math.cos(this.input.yaw);
    const sinYaw = Math.sin(this.input.yaw);

    const camera = this.ctx.camera;
    camera.position.set(
      this.eye.x + cosYaw * leanOffset,
      this.eye.y +
        state.height -
        EYE_OFFSET -
        Math.abs(state.lean) * LEAN_DROP +
        bob -
        this.landDip,
      this.eye.z - sinYaw * leanOffset,
    );
    camera.rotation.set(this.input.pitch, this.input.yaw, -state.lean * LEAN_ROLL, 'YXZ');

    const ads = this.viewmodel.adsAmount;
    const def = this.local.weapon;
    this.ctx.setFov(DEFAULT_FOV + (def.adsFov - DEFAULT_FOV) * ads, dt);

    this.viewmodel.setWeapon(def);
    const reloadRemaining = Math.max(0, this.local.reloadEndsAtMs - performance.now());
    this.viewmodel.update(dt, {
      speed,
      onGround: state.onGround,
      ads: (this.sample.buttons & BTN_ADS) !== 0,
      reloadProgress: this.local.reloading ? reloadRemaining / def.reloadMs : 0,
      deltaYaw: this.input.yaw - this.lastYaw,
      deltaPitch: this.input.pitch - this.lastPitch,
    });
    this.lastYaw = this.input.yaw;
    this.lastPitch = this.input.pitch;

    forwardFromAngles(this.forward, this.input.yaw, this.input.pitch);
    this.audio.updateListener(camera.position, this.forward);
  }

  private updateHud(now: number, frameMs: number): void {
    this.frameSamples.push(1000 / Math.max(1, frameMs));
    if (this.frameSamples.length > 30) this.frameSamples.shift();
    const fps = this.frameSamples.reduce((a, b) => a + b, 0) / this.frameSamples.length;

    const adsHeld = (this.sample.buttons & BTN_ADS) !== 0;
    this.cameraForward.set(0, 0, -1).applyQuaternion(this.ctx.camera.quaternion);
    const onEnemy = this.players.crosshairTarget(
      this.ctx.camera.position,
      this.cameraForward,
      this.myTeam,
    );
    this.hud.setScoped(this.viewmodel.scoped);
    this.hud.setCrosshair(
      this.local.currentSpread(adsHeld),
      (this.ctx.camera.fov * Math.PI) / 180,
      globalThis.innerHeight,
      onEnemy,
    );

    const elapsed = now - this.matchStateAt;
    this.hud.setMatchState(
      this.match.phase,
      Math.max(0, this.match.timeLeftMs - elapsed),
      this.match.round,
    );

    if (!this.local.alive && this.deathAtMs > 0) {
      this.hud.setRespawn(RESPAWN_DELAY_MS - (now - this.deathAtMs), this.killerName);
    } else {
      this.hud.setRespawn(null, null);
    }

    this.hud.renderScoreboard(this.roster.values(), this.myId, this.aliveIds);
    this.hud.renderRoster(this.roster.values(), this.myId, this.aliveIds);
    this.hud.setNetStats(
      fps,
      this.net.rttMs,
      `${this.roster.size} players | interp ${INTERP_DELAY_MS}ms | ${this.ctx.drawCalls} draws`,
    );
    this.hud.tick(now);
  }
}

// ---------------------------------------------------------------------- boot

let game: Game | null = null;

playButton.addEventListener('click', async () => {
  playButton.disabled = true;
  menuStatus.classList.remove('error');
  menuStatus.textContent = 'Connecting…';

  const name = nameField.value.trim() || `Operator ${Math.floor(Math.random() * 900 + 100)}`;
  const room = roomField.value.trim() || 'lobby';

  try {
    game ??= new Game();
    await game.start(name, room, teamChoice.value, weaponChoice.value);
    menuStatus.textContent = '';
  } catch (error) {
    menuStatus.textContent = error instanceof Error ? error.message : 'connection failed';
    menuStatus.classList.add('error');
    playButton.disabled = false;
  }
});

nameField.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') playButton.click();
});

// Remember the callsign between sessions.
const storedName = globalThis.localStorage?.getItem('cs_grid_name');
if (storedName) nameField.value = storedName;
nameField.addEventListener('change', () => {
  globalThis.localStorage?.setItem('cs_grid_name', nameField.value.trim());
});
