/**
 * WebSocket transport. Owns the connection, decodes the binary protocol, and
 * keeps a smoothed estimate of the server clock so entity interpolation has a
 * stable timeline to sample.
 */
import { BinaryReader, type Bytes } from '../shared/binary';
import {
  type MatchStateMsg,
  MsgType,
  type PlayerInfo,
  type Snapshot,
  type WelcomeMsg,
  type InputCommand,
  decodeMatchState,
  decodePlayerInfo,
  decodePong,
  decodeWelcome,
  encodeChat,
  encodeInputBatch,
  encodeJoin,
  encodePing,
  encodeSimple,
  readSnapshot,
} from '../shared/protocol';

export interface JoinOptions {
  name: string;
  team: number;
  weapon: number;
}

export interface NetHandlers {
  onWelcome(msg: WelcomeMsg): void;
  onSnapshot(snapshot: Snapshot): void;
  onPlayerInfo(info: PlayerInfo): void;
  onPlayerLeft(id: number): void;
  onMatchState(state: MatchStateMsg): void;
  onChat(fromId: number, text: string): void;
  onKick(reason: string): void;
  onClose(reason: string): void;
}

const PING_INTERVAL_MS = 1000;

export class NetClient {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Smoothed `serverTime - performance.now()`. */
  private clockOffsetMs = 0;
  private clockInitialized = false;

  rttMs = 0;
  connected = false;

  constructor(private readonly handlers: NetHandlers) {}

  /** Server clock estimate, in the same units the snapshots use. */
  serverNow(): number {
    return performance.now() + this.clockOffsetMs;
  }

  connect(url: string, join: JoinOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.connected = true;
        socket.send(encodeJoin(join.name, join.team, join.weapon));
        this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
        this.sendPing();
        settled = true;
        resolve();
      });

      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') return;
        this.handleMessage(new Uint8Array(event.data as ArrayBuffer));
      });

      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('could not reach the game server'));
        }
      });

      socket.addEventListener('close', (event) => {
        this.connected = false;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (!settled) {
          settled = true;
          reject(new Error('connection refused'));
          return;
        }
        this.handlers.onClose(event.reason || 'disconnected');
      });
    });
  }

  disconnect(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket?.close(1000, 'left');
    this.socket = null;
    this.connected = false;
  }

  private send(data: Bytes): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(data);
  }

  sendInputs(commands: readonly InputCommand[]): void {
    if (commands.length > 0) this.send(encodeInputBatch(commands));
  }

  selectWeapon(slot: number): void {
    this.send(encodeSimple(MsgType.SelectWeapon, slot));
  }

  requestRespawn(): void {
    this.send(encodeSimple(MsgType.RequestRespawn));
  }

  setTeam(team: number): void {
    this.send(encodeSimple(MsgType.SetTeam, team));
  }

  setBotSkill(index: number): void {
    this.send(encodeSimple(MsgType.SetBotSkill, index));
  }

  sendChat(text: string): void {
    this.send(encodeChat(text));
  }

  private sendPing(): void {
    this.send(encodePing(Math.round(performance.now()) >>> 0, this.rttMs));
  }

  private handleMessage(data: Uint8Array): void {
    const reader = new BinaryReader(data);
    const type = reader.u8() as MsgType;

    switch (type) {
      case MsgType.Welcome:
        this.handlers.onWelcome(decodeWelcome(reader));
        return;

      case MsgType.Snapshot: {
        const snapshot = readSnapshot(reader);
        this.syncClock(snapshot.serverTimeMs);
        this.handlers.onSnapshot(snapshot);
        return;
      }

      case MsgType.PlayerInfo:
        this.handlers.onPlayerInfo(decodePlayerInfo(reader));
        return;

      case MsgType.PlayerLeft:
        this.handlers.onPlayerLeft(reader.u16());
        return;

      case MsgType.MatchState:
        this.handlers.onMatchState(decodeMatchState(reader));
        return;

      case MsgType.Pong: {
        const pong = decodePong(reader);
        const rtt = performance.now() - pong.clientTimeMs;
        // Smooth the RTT so a single hiccup does not swing lag compensation.
        this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
        return;
      }

      case MsgType.ChatBroadcast:
        this.handlers.onChat(reader.u16(), reader.string());
        return;

      case MsgType.Kick:
        this.handlers.onKick(reader.string());
        return;

      default:
        return;
    }
  }

  /**
   * Track the server clock. Snapshots arrive late by roughly half the RTT, so
   * the raw offset is always a little behind; we snap forward eagerly and drift
   * backward slowly, which keeps the interpolation timeline monotonic.
   */
  private syncClock(serverTimeMs: number): void {
    const observed = serverTimeMs - performance.now();
    if (!this.clockInitialized) {
      this.clockOffsetMs = observed;
      this.clockInitialized = true;
      return;
    }
    if (observed > this.clockOffsetMs || Math.abs(observed - this.clockOffsetMs) > 500) {
      this.clockOffsetMs = observed;
    } else {
      this.clockOffsetMs += (observed - this.clockOffsetMs) * 0.02;
    }
  }
}
