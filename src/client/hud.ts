/** All DOM-side HUD state. Kept apart from the renderer so neither has to know
 * about the other. */
import { TEAM_COLORS, TEAM_NAMES, type TeamId } from '../shared/map';
import { angleDelta } from '../shared/math';
import { MatchPhase, type PlayerInfo } from '../shared/protocol';
import { getWeapon } from '../shared/weapons';

const KILLFEED_LIMIT = 6;
const KILLFEED_TTL_MS = 6500;
const CHAT_LIMIT = 6;
const CHAT_TTL_MS = 9000;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing HUD element #${id}`);
  return node as T;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface DamageMark {
  node: HTMLElement;
  yaw: number;
  until: number;
}

export class Hud {
  private readonly root = el('hud');
  private readonly crosshair = el('crosshair');
  private readonly hitmarker = el('hitmarker');
  private readonly scope = el('scope');
  private readonly damageRing = el('damage-ring');
  private readonly health = el('health');
  private readonly healthBar = el('health-bar');
  private readonly armor = el('armor');
  private readonly armorBar = el('armor-bar');
  private readonly bottomLeft = el('bottom-left');
  private readonly weaponName = el('weapon-name');
  private readonly ammoBox = el('ammo');
  private readonly ammoMag = el('ammo-mag');
  private readonly ammoReserve = el('ammo-reserve');
  private readonly reloadHint = el('reload-hint');
  private readonly scoreRed = el('score-red');
  private readonly scoreBlue = el('score-blue');
  private readonly roundTimer = el('round-timer');
  private readonly phaseBanner = el('phase-banner');
  private readonly killfeed = el('killfeed');
  private readonly chatLog = el('chat-log');
  private readonly respawn = el('respawn');
  private readonly scoreboard = el('scoreboard');
  private readonly sbRed = el<HTMLTableSectionElement>('sb-red');
  private readonly sbBlue = el<HTMLTableSectionElement>('sb-blue');
  private readonly sbRound = el('sb-round');
  private readonly fps = el('fps');
  private readonly ping = el('ping');
  private readonly tickInfo = el('tickinfo');
  private readonly roster = el('roster');
  private readonly rosterRed = el<HTMLUListElement>('roster-red');
  private readonly rosterBlue = el<HTMLUListElement>('roster-blue');
  private readonly pause = el('pause');
  private readonly skillNote = el('skill-note');
  private readonly chatForm = el<HTMLFormElement>('chat-input');
  private readonly chatField = this.chatForm.querySelector('input') as HTMLInputElement;

  private hitmarkerUntil = 0;
  private damageMarks: DamageMark[] = [];
  private killfeedEntries: { node: HTMLElement; until: number }[] = [];
  private chatEntries: { node: HTMLElement; until: number }[] = [];
  private bannerUntil = 0;

  constructor(private readonly onChatSubmit: (text: string) => void) {
    this.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.chatField.value.trim();
      this.chatField.value = '';
      this.closeChat();
      if (text) this.onChatSubmit(text);
    });
    this.chatField.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.chatField.value = '';
        this.closeChat();
      }
      event.stopPropagation();
    });
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  // ------------------------------------------------------------------ status

  setVitals(health: number, armorValue: number, alive: boolean): void {
    this.health.textContent = String(Math.max(0, health));
    this.armor.textContent = String(Math.max(0, armorValue));
    this.healthBar.style.width = `${Math.max(0, Math.min(100, health))}%`;
    this.armorBar.style.width = `${Math.max(0, Math.min(100, armorValue))}%`;
    this.bottomLeft.classList.toggle('hurt', alive && health <= 35);
  }

  setWeapon(weaponId: number, mag: number, reserve: number, reloading: boolean): void {
    const def = getWeapon(weaponId);
    this.weaponName.textContent = def.name;
    this.ammoMag.textContent = String(mag);
    this.ammoReserve.textContent = `/ ${reserve}`;
    this.ammoBox.classList.toggle('empty', mag === 0);
    this.reloadHint.classList.toggle('hidden', !reloading);
  }

  /**
   * Size the reticle from the real spread cone: the gap is the projection of
   * the cone onto the screen, so the crosshair literally shows where bullets
   * can land.
   */
  setCrosshair(spreadRad: number, fovRad: number, viewportHeight: number, onEnemy: boolean): void {
    const pixels = (Math.tan(spreadRad) / Math.tan(fovRad / 2)) * (viewportHeight / 2);
    const gap = Math.max(3, Math.min(90, pixels));
    this.crosshair.style.setProperty('--ch-gap', `${gap.toFixed(1)}px`);
    this.crosshair.style.setProperty('--ch-len', `${(5 + gap * 0.12).toFixed(1)}px`);
    this.crosshair.classList.toggle('enemy', onEnemy);
  }

  /**
   * Swap between the normal reticle and a scoped view. They are mutually
   * exclusive: the scope has its own etched reticle.
   */
  setScoped(scoped: boolean): void {
    this.scope.classList.toggle('hidden', !scoped);
    this.crosshair.classList.toggle('hidden', scoped);
  }

  /**
   * The always-visible kill/death roster. Rebuilt from scratch each time rather
   * than diffed: ten rows of text is nothing next to a frame of Three.js, and
   * the alternative is a pile of node-reuse bugs.
   */
  renderRoster(players: Iterable<PlayerInfo>, myId: number, aliveIds: ReadonlySet<number>): void {
    const byTeam: Record<TeamId, PlayerInfo[]> = { 0: [], 1: [] };
    for (const player of players) byTeam[player.team].push(player);

    for (const team of [0, 1] as TeamId[]) {
      const list = team === 0 ? this.rosterRed : this.rosterBlue;
      list.replaceChildren();
      const sorted = byTeam[team].toSorted((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      for (const player of sorted) {
        const row = document.createElement('li');
        if (player.id === myId) row.className = 'me';
        if (!aliveIds.has(player.id)) row.classList.add('down');

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = player.name;

        const kd = document.createElement('span');
        kd.className = 'kd';
        kd.textContent = `${player.kills}/${player.deaths}`;

        row.append(who, kd);
        list.append(row);
      }
    }
  }

  setRosterVisible(visible: boolean): void {
    this.roster.classList.toggle('hidden', !visible);
  }

  /** Show or hide the pause panel, and mark which difficulty is live. */
  setPaused(paused: boolean, skillIndex: number, skillNote: string): void {
    this.pause.classList.toggle('hidden', !paused);
    for (const button of this.pause.querySelectorAll<HTMLButtonElement>('#skill-choices button')) {
      button.classList.toggle('active', Number(button.dataset.value) === skillIndex);
    }
    this.skillNote.textContent = skillNote;
  }

  setPausedMap(mapIndex: number): void {
    for (const button of this.pause.querySelectorAll<HTMLButtonElement>('#map-choices button')) {
      button.classList.toggle('active', Number(button.dataset.value) === mapIndex);
    }
  }

  setPausedTeam(team: TeamId): void {
    for (const button of this.pause.querySelectorAll<HTMLButtonElement>('#team-choices button')) {
      button.classList.toggle('active', Number(button.dataset.value) === team);
    }
  }

  get paused(): boolean {
    return !this.pause.classList.contains('hidden');
  }

  setScores(red: number, blue: number): void {
    this.scoreRed.textContent = String(red);
    this.scoreBlue.textContent = String(blue);
  }

  setMatchState(phase: MatchPhase, timeLeftMs: number, round: number): void {
    this.roundTimer.textContent = formatClock(timeLeftMs);
    this.sbRound.textContent = `Round ${round}`;
    if (phase === MatchPhase.Warmup) this.banner('Warm-up', 1200);
    else if (phase === MatchPhase.RoundEnd) this.banner('Round over', 2600);
  }

  banner(text: string, ms: number): void {
    this.phaseBanner.textContent = text;
    this.phaseBanner.style.opacity = '1';
    this.bannerUntil = performance.now() + ms;
  }

  // ------------------------------------------------------------------ combat

  showHitmarker(kill: boolean): void {
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarker.style.opacity = '1';
    this.hitmarkerUntil = performance.now() + (kill ? 260 : 150);
  }

  showDamage(fromYaw: number, myYaw: number): void {
    const relative = angleDelta(myYaw, fromYaw);
    const node = document.createElement('div');
    node.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:0',
      'height:0',
      `transform:rotate(${relative}rad)`,
      'pointer-events:none',
    ].join(';');
    const arrow = document.createElement('div');
    arrow.style.cssText = [
      'position:absolute',
      'left:-13px',
      'top:-120px',
      'width:26px',
      'height:16px',
      'background:linear-gradient(180deg, rgba(255,70,50,0.95), rgba(255,70,50,0))',
      'clip-path:polygon(50% 0,100% 100%,0 100%)',
    ].join(';');
    node.append(arrow);
    this.root.append(node);
    this.damageMarks.push({ node, yaw: fromYaw, until: performance.now() + 900 });

    this.damageRing.style.opacity = '0.85';
    globalThis.setTimeout(() => {
      this.damageRing.style.opacity = '0';
    }, 90);
  }

  addKillfeed(
    killerName: string,
    killerTeam: TeamId,
    victimName: string,
    victimTeam: TeamId,
    weaponId: number,
    headshot: boolean,
    involvesMe: boolean,
  ): void {
    const node = document.createElement('div');
    node.className = 'kf';
    if (involvesMe) node.style.borderColor = 'rgba(255,255,255,0.35)';

    const killer = document.createElement('span');
    killer.textContent = killerName;
    killer.style.color = `#${TEAM_COLORS[killerTeam].toString(16).padStart(6, '0')}`;

    const weapon = document.createElement('span');
    weapon.className = 'weapon';
    weapon.textContent = getWeapon(weaponId).shortName;

    const victim = document.createElement('span');
    victim.textContent = victimName;
    victim.style.color = `#${TEAM_COLORS[victimTeam].toString(16).padStart(6, '0')}`;

    node.append(killer, weapon);
    if (headshot) {
      const hs = document.createElement('span');
      hs.className = 'hs';
      hs.textContent = 'HS';
      node.append(hs);
    }
    node.append(victim);

    this.killfeed.append(node);
    this.killfeedEntries.push({ node, until: performance.now() + KILLFEED_TTL_MS });
    while (this.killfeedEntries.length > KILLFEED_LIMIT) {
      this.killfeedEntries.shift()?.node.remove();
    }
  }

  setRespawn(msLeft: number | null, killerName: string | null): void {
    if (msLeft === null) {
      this.respawn.classList.add('hidden');
      return;
    }
    this.respawn.classList.remove('hidden');
    const killer = this.respawn.querySelector('.killer') as HTMLElement;
    const countdown = this.respawn.querySelector('.countdown b') as HTMLElement;
    killer.textContent = killerName ? `Eliminated by ${killerName}` : 'Eliminated';
    countdown.textContent = (Math.max(0, msLeft) / 1000).toFixed(1);
  }

  // -------------------------------------------------------------- scoreboard

  toggleScoreboard(open: boolean): void {
    this.scoreboard.classList.toggle('hidden', !open);
  }

  renderScoreboard(
    players: Iterable<PlayerInfo>,
    myId: number,
    aliveIds: ReadonlySet<number>,
  ): void {
    const rows: Record<TeamId, PlayerInfo[]> = { 0: [], 1: [] };
    for (const player of players) rows[player.team].push(player);

    for (const team of [0, 1] as TeamId[]) {
      const body = team === 0 ? this.sbRed : this.sbBlue;
      body.replaceChildren();
      const sorted = rows[team].toSorted((a, b) => b.score - a.score || b.kills - a.kills);
      for (const player of sorted) {
        const tr = document.createElement('tr');
        if (player.id === myId) tr.className = 'me';
        if (!aliveIds.has(player.id)) tr.classList.add('dead');

        const name = document.createElement('td');
        name.textContent = player.name;
        if (player.isBot) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'BOT';
          name.append(tag);
        }
        tr.append(name);
        for (const value of [player.kills, player.deaths, player.assists, player.score]) {
          const td = document.createElement('td');
          td.textContent = String(value);
          tr.append(td);
        }
        const ping = document.createElement('td');
        ping.textContent = player.isBot ? '-' : String(player.pingMs);
        tr.append(ping);
        body.append(tr);
      }
    }
  }

  // -------------------------------------------------------------------- chat

  openChat(): void {
    this.chatForm.classList.remove('hidden');
    this.chatField.focus();
  }

  closeChat(): void {
    this.chatForm.classList.add('hidden');
    this.chatField.blur();
  }

  get chatOpen(): boolean {
    return !this.chatForm.classList.contains('hidden');
  }

  addChat(name: string, team: TeamId, text: string): void {
    const node = document.createElement('div');
    node.className = 'chat-line';
    const who = document.createElement('b');
    who.textContent = `${name}: `;
    who.style.color = `#${TEAM_COLORS[team].toString(16).padStart(6, '0')}`;
    node.append(who, document.createTextNode(text));
    this.chatLog.append(node);
    this.chatEntries.push({ node, until: performance.now() + CHAT_TTL_MS });
    while (this.chatEntries.length > CHAT_LIMIT) this.chatEntries.shift()?.node.remove();
  }

  addSystem(text: string): void {
    const node = document.createElement('div');
    node.className = 'chat-line';
    node.style.color = '#8b9bb0';
    node.textContent = text;
    this.chatLog.append(node);
    this.chatEntries.push({ node, until: performance.now() + CHAT_TTL_MS });
    while (this.chatEntries.length > CHAT_LIMIT) this.chatEntries.shift()?.node.remove();
  }

  // ------------------------------------------------------------------- stats

  setNetStats(fps: number, pingMs: number, extra: string): void {
    this.fps.textContent = `${Math.round(fps)} fps`;
    this.ping.textContent = `${Math.round(pingMs)} ms`;
    this.tickInfo.textContent = extra;
  }

  teamName(team: TeamId): string {
    return TEAM_NAMES[team];
  }

  /** Expire transient elements. Call once per frame. */
  tick(now: number): void {
    if (this.hitmarkerUntil > 0 && now > this.hitmarkerUntil) {
      this.hitmarker.style.opacity = '0';
      this.hitmarkerUntil = 0;
    }
    if (this.bannerUntil > 0 && now > this.bannerUntil) {
      this.phaseBanner.style.opacity = '0';
      this.bannerUntil = 0;
    }
    if (this.damageMarks.length > 0) {
      this.damageMarks = this.damageMarks.filter((mark) => {
        if (now < mark.until) {
          mark.node.style.opacity = String(Math.max(0, (mark.until - now) / 900));
          return true;
        }
        mark.node.remove();
        return false;
      });
    }
    if (this.killfeedEntries.length > 0 && now > (this.killfeedEntries[0]?.until ?? Infinity)) {
      this.killfeedEntries.shift()?.node.remove();
    }
    if (this.chatEntries.length > 0 && now > (this.chatEntries[0]?.until ?? Infinity)) {
      this.chatEntries.shift()?.node.remove();
    }
  }
}
