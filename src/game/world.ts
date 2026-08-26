import { CHARACTER_COUNT, characterForId } from '../shared/characters';
import {
  type Brush,
  type MoveResult,
  type RayHit,
  makeBrush,
  raycastWorld,
  rayVsBrush,
} from '../shared/collision';
/**
 * The authoritative simulation. Deliberately free of any runtime-specific API
 * so it can run inside a Durable Object, inside Node for tests, or anywhere
 * else that can call `step()` on a timer.
 */
import {
  ACCURATE_MOVE_SPEED,
  ARMOR_ABSORB,
  BTN_ADS,
  BTN_ATTACK,
  BTN_CROUCH,
  BTN_LEAN_LEFT,
  BTN_LEAN_RIGHT,
  BTN_RELOAD,
  BTN_WALK,
  FALL_DAMAGE_PER_MS,
  FALL_DAMAGE_THRESHOLD,
  HEAD_HEIGHT,
  INTERP_DELAY_MS,
  type BotSkillName,
  MAX_HEALTH,
  MAX_REPEATED_INPUT_TICKS,
  MAX_REWIND_MS,
  PLAYER_RADIUS,
  RESPAWN_DELAY_MS,
  ROUND_END_MS,
  ROUND_MS,
  SCORE_LIMIT,
  SPAWN_PROTECTION_MS,
  SPAWN_PROTECTION_MS as SPAWN_PROT,
  START_ARMOR,
  TICK_RATE,
  WARMUP_MS,
  botSkillIndex,
} from '../shared/config';
import {
  DEFAULT_MAP_ID,
  type GameMap,
  type SpawnPoint,
  TEAM_BLUE,
  TEAM_RED,
  type TeamId,
  getMap,
  mapIndex,
} from '../shared/map';
import { Rng, type Vec3, distance, forwardFromAngles, vec3 } from '../shared/math';
import { horizontalSpeed, stepMovement } from '../shared/movement';
import { NavGraph } from '../shared/nav';
import {
  type EntitySnapshot,
  EventKind,
  type GameEvent,
  type InputCommand,
  type LocalSnapshot,
  MatchPhase,
  type MatchStateMsg,
  type PlayerInfo,
  type Snapshot,
} from '../shared/protocol';
import {
  HitZone,
  WeaponId,
  cyclesAfterShot,
  damageAtDistance,
  shotDelayMs,
  zoneMultiplier,
} from '../shared/weapons';
import { Combatant, type HistoryFrame } from './combatant';
import { pickBotName } from './names';

export const TICK_MS = 1000 / TICK_RATE;
const TICK_DT = 1 / TICK_RATE;
/** How many queued input commands a single client may cash in per tick. */
const MAX_COMMANDS_PER_TICK = 3;
const MAX_COMMAND_DT_MS = 50;
/** Damage share required to be credited with an assist. */
const ASSIST_DAMAGE = 40;

/**
 * Buttons that describe a sustained pose rather than an action. Only these are
 * carried over when input starves: repeating a fire or jump button would let a
 * stalled client keep shooting and hopping.
 */
const HELD_BUTTONS = BTN_CROUCH | BTN_WALK | BTN_ADS | BTN_LEAN_LEFT | BTN_LEAN_RIGHT;

export type BotSkill = BotSkillName;

export interface WorldOptions {
  targetPlayers: number;
  botSkill: BotSkill;
  seed: number;
  /** Which map to load. Changing it means building a new world. */
  mapId?: string;
}

export interface BotBrain {
  readonly combatant: Combatant;
  think(world: GameWorld): InputCommand;
}

export type BotFactory = (combatant: Combatant, skill: BotSkill, seed: number) => BotBrain;

const scratchEye = vec3();
const scratchDir = vec3();
const scratchHitPoint = vec3();
const scratchFrame: HistoryFrame = { timeMs: 0, x: 0, y: 0, z: 0, height: 0, alive: false };
const scratchRay: RayHit = { t: 0, nx: 0, ny: 0, nz: 0, brush: null };
/** Reused when input starves, so the hot path stays allocation-free. */
const repeatCommand: InputCommand = {
  seq: 0,
  dtMs: 16,
  buttons: 0,
  yaw: 0,
  pitch: 0,
  moveX: 0,
  moveZ: 0,
};
const scratchMove: MoveResult = {
  onGround: false,
  hitWall: false,
  hitCeiling: false,
  landingSpeed: 0,
};

export class GameWorld {
  readonly map: GameMap;
  readonly nav: NavGraph;
  readonly combatants = new Map<number, Combatant>();

  tick = 0;
  timeMs = 0;

  phase: MatchPhase = MatchPhase.Warmup;
  phaseEndsAtMs = WARMUP_MS;
  round = 1;
  scoreRed = 0;
  scoreBlue = 0;
  mvp = 0xffff;

  /** Events visible to everyone this tick. */
  private readonly broadcastEvents: GameEvent[] = [];
  /** Events that only concern one player (damage direction, etc). */
  private readonly privateEvents = new Map<number, GameEvent[]>();
  /** Set whenever roster metadata changed and PlayerInfo needs re-sending. */
  dirtyRoster = new Set<number>();
  /**
   * Ids that left since the last flush. Bots are removed silently by team
   * balancing, so without announcing them every client's scoreboard would
   * slowly fill up with players that are no longer in the match.
   */
  readonly departed: number[] = [];
  matchStateDirty = true;

  private nextId = 1;
  private readonly rng: Rng;
  /**
   * Cosmetic choices draw from their own stream. Sharing the gameplay RNG would
   * mean that adding a purely visual decision shifts every subsequent roll -
   * spread, spawn choice, bot loadout - and silently moves the numbers that
   * seeded regression tests measure.
   */
  private readonly cosmeticRng: Rng;
  private readonly bots: BotBrain[] = [];
  private botFactory: BotFactory | null = null;
  /** Seed each bot was built with, so a difficulty change can rebuild it. */
  private readonly botSeeds = new Map<number, number>();

  constructor(readonly options: WorldOptions) {
    this.map = getMap(options.mapId ?? DEFAULT_MAP_ID);
    this.rng = new Rng(options.seed);
    this.cosmeticRng = new Rng((options.seed ^ 0x5eed_c05e) >>> 0);
    this.nav = NavGraph.build(this.map);
  }

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  setBotFactory(factory: BotFactory): void {
    this.botFactory = factory;
  }

  get playerCount(): number {
    return this.combatants.size;
  }

  get humanCount(): number {
    let n = 0;
    for (const c of this.combatants.values()) if (!c.isBot) n++;
    return n;
  }

  private takenNames(): Set<string> {
    const names = new Set<string>();
    for (const c of this.combatants.values()) names.add(c.name);
    return names;
  }

  /** Team with fewer players, breaking ties by total score. */
  private weakestTeam(): TeamId {
    let red = 0;
    let blue = 0;
    let redScore = 0;
    let blueScore = 0;
    for (const c of this.combatants.values()) {
      if (c.team === TEAM_RED) {
        red++;
        redScore += c.score;
      } else {
        blue++;
        blueScore += c.score;
      }
    }
    if (red !== blue) return red < blue ? TEAM_RED : TEAM_BLUE;
    return redScore <= blueScore ? TEAM_RED : TEAM_BLUE;
  }

  addPlayer(
    name: string,
    isBot: boolean,
    preferredTeam: number,
    weapon: WeaponId,
    character = -1,
  ): Combatant {
    const id = this.nextId++;
    const team: TeamId =
      preferredTeam === TEAM_RED || preferredTeam === TEAM_BLUE
        ? (preferredTeam as TeamId)
        : this.weakestTeam();
    const finalName =
      name.trim().slice(0, 20) || (isBot ? pickBotName(this.takenNames()) : `Player ${id}`);
    const combatant = new Combatant(id, finalName, team, isBot);
    combatant.character =
      character >= 0 && character < CHARACTER_COUNT ? character : characterForId(id);
    combatant.setLoadout(weapon);
    this.combatants.set(id, combatant);
    this.dirtyRoster.add(id);
    this.respawn(combatant, true);
    return combatant;
  }

  addBot(skill: BotSkill = this.options.botSkill): Combatant | null {
    if (!this.botFactory) return null;
    const loadout = this.rng.pick([
      WeaponId.Rifle,
      WeaponId.Rifle,
      WeaponId.Smg,
      WeaponId.Rifle,
      WeaponId.Sniper,
      WeaponId.Shotgun,
    ]);
    const combatant = this.addPlayer(
      pickBotName(this.takenNames()),
      true,
      -1,
      loadout,
      this.cosmeticRng.int(CHARACTER_COUNT),
    );
    this.bots.push(
      this.botFactory(combatant, skill, (this.rng.int(0x7fffffff) ^ combatant.id) >>> 0),
    );
    return combatant;
  }

  removePlayer(id: number): void {
    if (!this.combatants.delete(id)) return;
    this.privateEvents.delete(id);
    this.dirtyRoster.delete(id);
    this.botSeeds.delete(id);
    const index = this.bots.findIndex((b) => b.combatant.id === id);
    if (index >= 0) this.bots.splice(index, 1);
    this.departed.push(id);
  }

  /**
   * Change difficulty mid-match. Brains hold their profile from construction,
   * so every bot is rebuilt on its original seed - they forget what they were
   * chasing, which is a fair price for not having to make every profile field
   * reactive.
   */
  setBotSkill(skill: BotSkill): boolean {
    if (skill === this.options.botSkill) return false;
    this.options.botSkill = skill;
    const factory = this.botFactory;
    if (factory) {
      for (const [index, bot] of this.bots.entries()) {
        const seed = this.botSeeds.get(bot.combatant.id) ?? bot.combatant.id;
        this.bots[index] = factory(bot.combatant, skill, seed);
      }
    }
    this.matchStateDirty = true;
    return true;
  }

  get botSkill(): BotSkill {
    return this.options.botSkill;
  }

  /** Drop or add bots so the match stays at the configured headcount. */
  balanceBots(): void {
    const target = Math.max(2, this.options.targetPlayers);
    let guard = 32;
    while (this.playerCount < target && guard-- > 0) {
      if (!this.addBot()) break;
    }
    while (this.playerCount > target && guard-- > 0) {
      const victim = this.bots.toReversed().find((b) => b.combatant.isBot);
      if (!victim) break;
      this.removePlayer(victim.combatant.id);
    }
    this.rebalanceTeams();
  }

  /** Move bots between teams when humans join or leave and skew the sides. */
  private rebalanceTeams(): void {
    for (let pass = 0; pass < 8; pass++) {
      let red = 0;
      let blue = 0;
      for (const c of this.combatants.values()) {
        if (c.team === TEAM_RED) red++;
        else blue++;
      }
      if (Math.abs(red - blue) <= 1) return;
      const from: TeamId = red > blue ? TEAM_RED : TEAM_BLUE;
      const to: TeamId = from === TEAM_RED ? TEAM_BLUE : TEAM_RED;
      const mover = [...this.combatants.values()].find((c) => c.isBot && c.team === from);
      if (!mover) return;
      mover.team = to;
      this.dirtyRoster.add(mover.id);
      this.respawn(mover, true);
    }
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /** Pick the spawn point that is furthest from the nearest living enemy. */
  private chooseSpawn(team: TeamId): SpawnPoint {
    const candidates = this.map.spawns.filter((s) => s.team === team);
    let best = candidates[0] as SpawnPoint;
    let bestScore = -Infinity;
    for (const spawn of candidates) {
      let nearestEnemy = Infinity;
      let nearestFriend = Infinity;
      for (const c of this.combatants.values()) {
        if (!c.alive) continue;
        const d = distance(c.move.pos, spawn.pos);
        if (c.team === team) nearestFriend = Math.min(nearestFriend, d);
        else nearestEnemy = Math.min(nearestEnemy, d);
      }
      // Prefer distance from enemies, mildly avoid stacking on teammates.
      const score =
        Math.min(nearestEnemy, 60) -
        Math.max(0, 4 - Math.min(nearestFriend, 4)) * 6 +
        this.rng.range(0, 3);
      if (score > bestScore) {
        bestScore = score;
        best = spawn;
      }
    }
    return best;
  }

  respawn(c: Combatant, immediate = false): void {
    const spawn = this.chooseSpawn(c.team);
    c.move.pos.x = spawn.pos.x;
    c.move.pos.y = spawn.pos.y;
    c.move.pos.z = spawn.pos.z;
    c.move.vel.x = 0;
    c.move.vel.y = 0;
    c.move.vel.z = 0;
    c.move.yaw = spawn.yaw;
    c.move.pitch = 0;
    c.move.crouching = false;
    c.move.lean = 0;
    c.health = MAX_HEALTH;
    c.armor = START_ARMOR;
    c.alive = true;
    c.respawnAtMs = 0;
    c.spawnProtectedUntilMs = this.timeMs + (immediate ? SPAWN_PROT : SPAWN_PROTECTION_MS);
    c.damageTaken.clear();
    c.refillAmmo();
    this.broadcastEvents.push({
      kind: EventKind.Spawn,
      id: c.id,
      x: spawn.pos.x,
      y: spawn.pos.y,
      z: spawn.pos.z,
    });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  queueInput(id: number, commands: readonly InputCommand[]): void {
    const c = this.combatants.get(id);
    if (!c) return;
    for (const cmd of commands) {
      if (cmd.seq <= c.lastProcessedSeq) continue;
      if (c.pendingInputs.some((p) => p.seq === cmd.seq)) continue;
      c.pendingInputs.push(cmd);
    }
    c.pendingInputs.sort((a, b) => a.seq - b.seq);
    // Bound the queue so a client cannot bank movement and burst it later.
    if (c.pendingInputs.length > 32) c.pendingInputs.splice(0, c.pendingInputs.length - 32);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.timeMs = this.tick * TICK_MS;

    this.updatePhase();

    for (const bot of this.bots) {
      if (!this.combatants.has(bot.combatant.id)) continue;
      const cmd = bot.think(this);
      bot.combatant.pendingInputs.push(cmd);
    }

    for (const c of this.combatants.values()) {
      this.simulateCombatant(c);
    }

    for (const c of this.combatants.values()) {
      c.recordHistory(this.timeMs);
    }

    for (const c of this.combatants.values()) {
      if (!c.alive && c.respawnAtMs > 0 && this.timeMs >= c.respawnAtMs) {
        this.respawn(c);
      }
    }
  }

  private updatePhase(): void {
    if (this.timeMs < this.phaseEndsAtMs) {
      if (
        this.phase === MatchPhase.Live &&
        (this.scoreRed >= SCORE_LIMIT || this.scoreBlue >= SCORE_LIMIT)
      ) {
        this.endRound();
      }
      return;
    }

    if (this.phase === MatchPhase.Warmup) {
      this.phase = MatchPhase.Live;
      this.phaseEndsAtMs = this.timeMs + ROUND_MS;
      this.matchStateDirty = true;
    } else if (this.phase === MatchPhase.Live) {
      this.endRound();
    } else {
      this.startRound();
    }
  }

  private endRound(): void {
    this.phase = MatchPhase.RoundEnd;
    this.phaseEndsAtMs = this.timeMs + ROUND_END_MS;
    let bestScore = -Infinity;
    this.mvp = 0xffff;
    for (const c of this.combatants.values()) {
      if (c.score > bestScore) {
        bestScore = c.score;
        this.mvp = c.id;
      }
    }
    this.matchStateDirty = true;
  }

  private startRound(): void {
    this.round++;
    this.scoreRed = 0;
    this.scoreBlue = 0;
    this.mvp = 0xffff;
    this.phase = MatchPhase.Live;
    this.phaseEndsAtMs = this.timeMs + ROUND_MS;
    for (const c of this.combatants.values()) {
      c.kills = 0;
      c.deaths = 0;
      c.assists = 0;
      c.score = 0;
      c.streak = 0;
      this.dirtyRoster.add(c.id);
      this.respawn(c, true);
    }
    this.matchStateDirty = true;
  }

  private simulateCombatant(c: Combatant): void {
    const budget = Math.min(c.pendingInputs.length, MAX_COMMANDS_PER_TICK);
    if (budget === 0) {
      // No input this tick. Keep physics running so the player still falls, and
      // hold their last pose so a dropped packet does not read as "let go of
      // everything" - see MAX_REPEATED_INPUT_TICKS.
      if (c.alive) {
        const held = c.lastCommand;
        const repeat = held !== null && c.starvedTicks < MAX_REPEATED_INPUT_TICKS;
        repeatCommand.buttons = repeat && held ? held.buttons & HELD_BUTTONS : 0;
        repeatCommand.yaw = held ? held.yaw : c.move.yaw;
        repeatCommand.pitch = held ? held.pitch : c.move.pitch;
        repeatCommand.moveX = repeat && held ? held.moveX : 0;
        repeatCommand.moveZ = repeat && held ? held.moveZ : 0;
        c.starvedTicks++;

        stepMovement(
          c.move,
          repeatCommand,
          this.map.brushes,
          TICK_DT,
          c.weaponDef.moveSpeedMultiplier,
          scratchMove,
        );
        this.applyFallDamage(c, scratchMove);
      }
      this.decaySpread(c, TICK_DT);
      return;
    }

    c.starvedTicks = 0;
    for (let i = 0; i < budget; i++) {
      const cmd = c.pendingInputs.shift() as InputCommand;
      c.lastCommand = cmd;
      c.lastProcessedSeq = Math.max(c.lastProcessedSeq, cmd.seq);
      const dt = Math.min(MAX_COMMAND_DT_MS, Math.max(1, cmd.dtMs)) / 1000;

      if (!c.alive) {
        c.move.yaw = cmd.yaw;
        c.move.pitch = cmd.pitch;
        continue;
      }

      stepMovement(c.move, cmd, this.map.brushes, dt, c.weaponDef.moveSpeedMultiplier, scratchMove);
      this.applyFallDamage(c, scratchMove);
      this.decaySpread(c, dt);
      this.handleWeapon(c, cmd);
    }
  }

  private applyFallDamage(c: Combatant, result: MoveResult): void {
    if (result.landingSpeed <= FALL_DAMAGE_THRESHOLD) return;
    const damage = Math.round((result.landingSpeed - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_MS);
    if (damage > 0) this.applyDamage(c, null, damage, HitZone.Legs, c.weapon.weapon);
  }

  private decaySpread(c: Combatant, dt: number): void {
    const def = c.weaponDef;
    c.spread = Math.max(0, c.spread - def.spreadRecoveryPerSec * dt);
  }

  private handleWeapon(c: Combatant, cmd: InputCommand): void {
    const def = c.weaponDef;
    const slot = c.weapon;
    c.wantsAds = (cmd.buttons & (1 << 9)) !== 0;

    if (c.reloadEndsAtMs > 0 && this.timeMs >= c.reloadEndsAtMs) {
      const needed = def.magSize - slot.ammo;
      const taken = Math.min(needed, slot.reserve);
      slot.ammo += taken;
      slot.reserve -= taken;
      c.reloadEndsAtMs = 0;
      c.shotsSinceCycle = 0;
    }

    const wantsReload = (cmd.buttons & BTN_RELOAD) !== 0;
    if (wantsReload && c.reloadEndsAtMs === 0 && slot.ammo < def.magSize && slot.reserve > 0) {
      c.reloadEndsAtMs = this.timeMs + def.reloadMs;
      this.broadcastEvents.push({ kind: EventKind.Reload, id: c.id });
    }

    const triggerDown = (cmd.buttons & BTN_ATTACK) !== 0;
    const canFire =
      triggerDown &&
      c.reloadEndsAtMs === 0 &&
      this.timeMs >= c.nextFireAtMs &&
      (def.automatic || !c.triggerWasDown);
    c.triggerWasDown = triggerDown;

    if (!canFire) return;

    if (slot.ammo <= 0) {
      // Dry fire: start a reload automatically so bots never stall.
      if (slot.reserve > 0 && c.reloadEndsAtMs === 0) {
        c.reloadEndsAtMs = this.timeMs + def.reloadMs;
        this.broadcastEvents.push({ kind: EventKind.Reload, id: c.id });
      }
      c.nextFireAtMs = this.timeMs + 250;
      return;
    }

    slot.ammo--;
    c.shotsSinceCycle++;
    c.nextFireAtMs = this.timeMs + shotDelayMs(def, c.shotsSinceCycle);
    if (cyclesAfterShot(def, c.shotsSinceCycle)) c.shotsSinceCycle = 0;
    c.firingUntilMs = this.timeMs + 90;
    this.fireShot(c, cmd);
    c.spread = Math.min(def.spreadMax, c.spread + def.spreadPerShot);
  }

  /** Total cone half-angle for this shot, in radians. */
  private currentSpread(c: Combatant): number {
    const def = c.weaponDef;
    let spread = def.spreadBase + c.spread;
    const speed = horizontalSpeed(c.move);
    if (speed > ACCURATE_MOVE_SPEED) {
      spread += def.moveInaccuracy * ((speed - ACCURATE_MOVE_SPEED) / 4);
    }
    if (!c.move.onGround) spread += def.airInaccuracy;
    if (c.move.crouching) spread *= 0.72;
    if (c.wantsAds) spread *= def.adsSpreadMultiplier;
    return spread;
  }

  private fireShot(shooter: Combatant, cmd: InputCommand): void {
    const def = shooter.weaponDef;
    shooter.eyePosition(scratchEye);

    const spread = this.currentSpread(shooter);
    const rewindMs = shooter.isBot
      ? 0
      : Math.min(MAX_REWIND_MS, Math.max(0, shooter.pingMs / 2 + INTERP_DELAY_MS));
    const rewindTime = this.timeMs - rewindMs;

    for (let pellet = 0; pellet < def.pellets; pellet++) {
      forwardFromAngles(scratchDir, cmd.yaw, cmd.pitch);
      if (spread > 0) {
        // Offset within the cone using two gaussian samples, then renormalize.
        const angle = this.rng.range(0, Math.PI * 2);
        const magnitude = Math.abs(this.rng.gaussian()) * spread * 0.5;
        const upX = 0;
        const upY = 1;
        const upZ = 0;
        // right = dir x up
        let rx = scratchDir.y * upZ - scratchDir.z * upY;
        let ry = scratchDir.z * upX - scratchDir.x * upZ;
        let rz = scratchDir.x * upY - scratchDir.y * upX;
        const rLen = Math.hypot(rx, ry, rz) || 1;
        rx /= rLen;
        ry /= rLen;
        rz /= rLen;
        // up' = right x dir
        const ux = ry * scratchDir.z - rz * scratchDir.y;
        const uy = rz * scratchDir.x - rx * scratchDir.z;
        const uz = rx * scratchDir.y - ry * scratchDir.x;
        const ca = Math.cos(angle) * magnitude;
        const sa = Math.sin(angle) * magnitude;
        scratchDir.x += rx * ca + ux * sa;
        scratchDir.y += ry * ca + uy * sa;
        scratchDir.z += rz * ca + uz * sa;
        const len = Math.hypot(scratchDir.x, scratchDir.y, scratchDir.z) || 1;
        scratchDir.x /= len;
        scratchDir.y /= len;
        scratchDir.z /= len;
      }

      this.traceBullet(shooter, scratchEye, scratchDir, def.range, rewindTime);
    }
  }

  private traceBullet(
    shooter: Combatant,
    origin: Vec3,
    dir: Vec3,
    range: number,
    rewindTime: number,
  ): void {
    let closestT = range;
    let target: Combatant | null = null;
    let zone = HitZone.Body;

    for (const other of this.combatants.values()) {
      if (other.id === shooter.id || !other.alive) continue;
      if (other.team === shooter.team) continue; // teammates do not block shots
      other.historyAt(rewindTime, scratchFrame);
      if (!scratchFrame.alive) continue;

      const hull = makeBrush(
        scratchFrame.x - PLAYER_RADIUS,
        scratchFrame.y,
        scratchFrame.z - PLAYER_RADIUS,
        scratchFrame.x + PLAYER_RADIUS,
        scratchFrame.y + scratchFrame.height,
        scratchFrame.z + PLAYER_RADIUS,
      );
      const t = rayVsBrush(
        origin.x,
        origin.y,
        origin.z,
        dir.x,
        dir.y,
        dir.z,
        hull,
        closestT,
        scratchRay,
      );
      if (t < 0 || t >= closestT) continue;

      const hitY = origin.y + dir.y * t;
      const relative = hitY - scratchFrame.y;
      zone =
        relative >= scratchFrame.height - HEAD_HEIGHT
          ? HitZone.Head
          : relative <= scratchFrame.height * 0.35
            ? HitZone.Legs
            : HitZone.Body;
      closestT = t;
      target = other;
    }

    const worldHit = raycastWorld(this.map.brushes, origin, dir, range, scratchRay);
    if (worldHit && scratchRay.t < closestT) {
      target = null;
      closestT = scratchRay.t;
    }

    const endX = origin.x + dir.x * closestT;
    const endY = origin.y + dir.y * closestT;
    const endZ = origin.z + dir.z * closestT;

    this.broadcastEvents.push({
      kind: EventKind.Shot,
      shooter: shooter.id,
      weapon: shooter.weapon.weapon,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      ex: endX,
      ey: endY,
      ez: endZ,
    });

    if (target) {
      const def = shooter.weaponDef;
      const damage = Math.round(damageAtDistance(def, closestT) * zoneMultiplier(def, zone));
      scratchHitPoint.x = endX;
      scratchHitPoint.y = endY;
      scratchHitPoint.z = endZ;
      this.broadcastEvents.push({
        kind: EventKind.Hit,
        attacker: shooter.id,
        target: target.id,
        x: endX,
        y: endY,
        z: endZ,
        zone,
        damage,
      });
      this.applyDamage(target, shooter, damage, zone, shooter.weapon.weapon);
    } else if (worldHit) {
      this.broadcastEvents.push({
        kind: EventKind.Impact,
        x: endX,
        y: endY,
        z: endZ,
        nx: scratchRay.nx,
        ny: scratchRay.ny,
        nz: scratchRay.nz,
      });
    }
  }

  private applyDamage(
    victim: Combatant,
    attacker: Combatant | null,
    rawDamage: number,
    zone: HitZone,
    weapon: WeaponId,
  ): void {
    if (!victim.alive) return;
    if (this.timeMs < victim.spawnProtectedUntilMs && attacker) return;

    let damage = rawDamage;
    if (victim.armor > 0 && zone !== HitZone.Legs) {
      const absorbed = Math.min(victim.armor, Math.round(damage * ARMOR_ABSORB));
      victim.armor -= absorbed;
      damage -= absorbed;
    }
    victim.health -= damage;

    if (attacker) {
      victim.damageTaken.set(attacker.id, (victim.damageTaken.get(attacker.id) ?? 0) + damage);
      const dirYaw = Math.atan2(
        -(attacker.move.pos.x - victim.move.pos.x),
        -(attacker.move.pos.z - victim.move.pos.z),
      );
      this.pushPrivate(victim.id, {
        kind: EventKind.TookDamage,
        attacker: attacker.id,
        amount: Math.min(255, damage),
        dirYaw,
      });
    }

    if (victim.health > 0) return;
    this.killCombatant(victim, attacker, weapon, zone === HitZone.Head);
  }

  private killCombatant(
    victim: Combatant,
    attacker: Combatant | null,
    weapon: WeaponId,
    headshot: boolean,
  ): void {
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.score -= 1;
    victim.respawnAtMs = this.timeMs + RESPAWN_DELAY_MS;
    victim.move.vel.x = 0;
    victim.move.vel.y = 0;
    victim.move.vel.z = 0;
    victim.reloadEndsAtMs = 0;
    this.dirtyRoster.add(victim.id);

    if (attacker && attacker.id !== victim.id) {
      attacker.kills++;
      attacker.streak++;
      attacker.score += headshot ? 3 : 2;
      if (attacker.team === TEAM_RED) this.scoreRed++;
      else this.scoreBlue++;
      this.dirtyRoster.add(attacker.id);

      for (const [contributorId, amount] of victim.damageTaken) {
        if (contributorId === attacker.id || amount < ASSIST_DAMAGE) continue;
        const contributor = this.combatants.get(contributorId);
        if (!contributor) continue;
        contributor.assists++;
        contributor.score += 1;
        this.dirtyRoster.add(contributorId);
      }
    }

    this.broadcastEvents.push({
      kind: EventKind.Kill,
      killer: attacker?.id ?? victim.id,
      victim: victim.id,
      weapon,
      headshot,
    });
    this.matchStateDirty = true;
  }

  private pushPrivate(id: number, event: GameEvent): void {
    let list = this.privateEvents.get(id);
    if (!list) {
      list = [];
      this.privateEvents.set(id, list);
    }
    list.push(event);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  buildSnapshot(viewerId: number, out: Snapshot): Snapshot {
    const viewer = this.combatants.get(viewerId);
    out.tick = this.tick;
    out.serverTimeMs = Math.round(this.timeMs);
    out.ackSeq = viewer?.lastProcessedSeq ?? 0;
    out.entities.length = 0;
    out.events.length = 0;

    const local = out.local;
    if (viewer) {
      const slot = viewer.weapon;
      local.x = viewer.move.pos.x;
      local.y = viewer.move.pos.y;
      local.z = viewer.move.pos.z;
      local.vx = viewer.move.vel.x;
      local.vy = viewer.move.vel.y;
      local.vz = viewer.move.vel.z;
      local.yaw = viewer.move.yaw;
      local.pitch = viewer.move.pitch;
      local.flags = viewer.snapshotFlags(this.timeMs);
      local.health = Math.max(0, Math.round(viewer.health));
      local.armor = Math.max(0, Math.round(viewer.armor));
      local.weapon = slot.weapon;
      local.ammo = slot.ammo;
      local.reserve = slot.reserve;
      local.reloadMs = Math.max(0, Math.round(viewer.reloadEndsAtMs - this.timeMs));
      local.spread = Math.min(65535, Math.round(this.currentSpread(viewer) * 10000));
      local.height = viewer.move.height;
      local.lean = viewer.move.lean;
    }

    for (const c of this.combatants.values()) {
      if (c.id === viewerId) continue;
      out.entities.push({
        id: c.id,
        x: c.move.pos.x,
        y: c.move.pos.y,
        z: c.move.pos.z,
        yaw: c.move.yaw,
        pitch: c.move.pitch,
        flags: c.snapshotFlags(this.timeMs),
        health: Math.max(0, Math.round(c.health)),
        weapon: c.weapon.weapon,
        heightCm: Math.round(c.move.height * 100),
        lean: c.move.lean,
      } satisfies EntitySnapshot);
    }

    for (const event of this.broadcastEvents) out.events.push(event);
    const mine = this.privateEvents.get(viewerId);
    if (mine) for (const event of mine) out.events.push(event);

    return out;
  }

  /** Call once after all snapshots for this tick have been serialized. */
  clearEvents(): void {
    this.broadcastEvents.length = 0;
    this.privateEvents.clear();
  }

  playerInfo(c: Combatant): PlayerInfo {
    return {
      id: c.id,
      name: c.name,
      team: c.team,
      isBot: c.isBot,
      kills: c.kills,
      deaths: c.deaths,
      assists: c.assists,
      score: c.score,
      pingMs: Math.round(c.pingMs),
      character: c.character,
    };
  }

  matchState(): MatchStateMsg {
    return {
      phase: this.phase,
      timeLeftMs: Math.max(0, Math.round(this.phaseEndsAtMs - this.timeMs)),
      scoreRed: this.scoreRed,
      scoreBlue: this.scoreBlue,
      round: this.round,
      mvp: this.mvp,
      botSkill: botSkillIndex(this.options.botSkill),
      mapId: mapIndex(this.map.id),
    };
  }
}

export function emptySnapshot(): Snapshot {
  const local: LocalSnapshot = {
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
    lean: 0,
  };
  return { tick: 0, serverTimeMs: 0, ackSeq: 0, local, entities: [], events: [] };
}

export type { Brush };
