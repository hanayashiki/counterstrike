/**
 * Fully synthesized audio - no sample files, so the client bundle stays tiny.
 * Gunfire is a filtered noise burst layered with a low thump; everything else
 * is shaped oscillators. Remote sounds are positioned with a PannerNode.
 */
import type { Vec3 } from '../shared/math';
import { WeaponId } from '../shared/weapons';

interface ShotVoice {
  duration: number;
  bandpass: number;
  bandQ: number;
  lowpassFrom: number;
  lowpassTo: number;
  thump: number;
  gain: number;
  /**
   * Bright attack transient layered over the body. This is what makes a shot
   * read as sharp rather than muffled: a very short burst of high-passed noise
   * that models the initial crack before the low end blooms. 0 disables it.
   */
  crackGain: number;
  /** High-pass corner for the transient, in Hz. */
  crackHz: number;
  /** How long the transient takes to decay, in seconds. */
  crackDuration: number;
}

const SHOT_VOICES: Record<number, ShotVoice> = {
  [WeaponId.Pistol]: {
    duration: 0.17,
    bandpass: 1500,
    bandQ: 0.9,
    lowpassFrom: 7000,
    lowpassTo: 700,
    thump: 130,
    gain: 0.55,
    crackGain: 0,
    crackHz: 0,
    crackDuration: 0,
  },
  [WeaponId.Smg]: {
    duration: 0.13,
    bandpass: 2100,
    bandQ: 1.1,
    lowpassFrom: 8200,
    lowpassTo: 900,
    thump: 150,
    gain: 0.48,
    crackGain: 0,
    crackHz: 0,
    crackDuration: 0,
  },
  [WeaponId.Rifle]: {
    duration: 0.24,
    bandpass: 1150,
    bandQ: 0.75,
    lowpassFrom: 9000,
    lowpassTo: 520,
    thump: 95,
    gain: 0.72,
    crackGain: 0,
    crackHz: 0,
    crackDuration: 0,
  },
  [WeaponId.Shotgun]: {
    // Tighter and brighter than a pure boom: the body still carries weight,
    // but the lowpass now opens up to 12 kHz before it closes, and a short
    // high-passed crack sits on the front of it.
    duration: 0.28,
    bandpass: 950,
    bandQ: 0.85,
    lowpassFrom: 12000,
    lowpassTo: 420,
    thump: 80,
    gain: 0.86,
    crackGain: 0.5,
    crackHz: 3200,
    crackDuration: 0.055,
  },
  [WeaponId.Sniper]: {
    duration: 0.55,
    bandpass: 780,
    bandQ: 0.6,
    lowpassFrom: 10000,
    lowpassTo: 320,
    thump: 68,
    gain: 0.95,
    crackGain: 0,
    crackHz: 0,
    crackDuration: 0,
  },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastFootstepAt = 0;

  volume = 0.7;

  /** Must be called from a user gesture. */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    master.gain.value = this.volume;

    // Gentle limiter so a spray of shots does not clip.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 12;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.16;

    master.connect(compressor).connect(ctx.destination);

    const seconds = 1;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noiseBuffer = buffer;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  setVolume(value: number): void {
    this.volume = value;
    if (this.master) this.master.gain.value = value;
  }

  /** Keep the listener in sync with the camera so panning makes sense. */
  updateListener(position: Vec3, forward: Vec3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const listener = ctx.listener;
    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  private destination(position?: Vec3): AudioNode | null {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return null;
    if (!position) return master;

    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 6;
    panner.maxDistance = 120;
    panner.rolloffFactor = 1.1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    panner.connect(master);
    return panner;
  }

  gunshot(weaponId: number, position?: Vec3, loudness = 1): void {
    const ctx = this.ctx;
    const noiseBuffer = this.noiseBuffer;
    const target = this.destination(position);
    if (!ctx || !noiseBuffer || !target) return;

    const voice = SHOT_VOICES[weaponId] ?? (SHOT_VOICES[WeaponId.Rifle] as ShotVoice);
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.playbackRate.value = 0.85 + Math.random() * 0.3;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = voice.bandpass * (0.9 + Math.random() * 0.2);
    bandpass.Q.value = voice.bandQ;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(voice.lowpassFrom, now);
    lowpass.frequency.exponentialRampToValueAtTime(voice.lowpassTo, now + voice.duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(voice.gain * loudness, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + voice.duration);

    noise.connect(bandpass).connect(lowpass).connect(gain).connect(target);
    noise.start(now);
    noise.stop(now + voice.duration + 0.02);

    // The attack transient, layered in front of the body.
    if (voice.crackGain > 0) {
      const crack = ctx.createBufferSource();
      crack.buffer = noiseBuffer;
      crack.playbackRate.value = 1.35 + Math.random() * 0.45;

      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = voice.crackHz;

      // A resonant peak an octave up gives the snap somewhere to sit.
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = voice.crackHz * 1.7;
      presence.Q.value = 1.1;
      presence.gain.value = 7;

      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(voice.crackGain * loudness, now);
      crackGain.gain.exponentialRampToValueAtTime(0.0005, now + voice.crackDuration);

      crack.connect(highpass).connect(presence).connect(crackGain).connect(target);
      crack.start(now);
      crack.stop(now + voice.crackDuration + 0.02);
    }

    // Low-end body.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(voice.thump, now);
    thump.frequency.exponentialRampToValueAtTime(voice.thump * 0.45, now + voice.duration * 0.7);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(voice.gain * 0.7 * loudness, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.0008, now + voice.duration * 0.8);
    thump.connect(thumpGain).connect(target);
    thump.start(now);
    thump.stop(now + voice.duration);
  }

  impact(position: Vec3): void {
    this.noiseBurst(0.06, 3200, 0.16, position);
  }

  bulletFlyby(position: Vec3): void {
    const ctx = this.ctx;
    const target = this.destination(position);
    if (!ctx || !target) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2600, now);
    osc.frequency.exponentialRampToValueAtTime(700, now + 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.1);
    osc.connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + 0.11);
  }

  hitmarker(headshot: boolean): void {
    this.tone(headshot ? 1500 : 950, 0.05, 0.16, 'square');
  }

  kill(): void {
    this.tone(760, 0.07, 0.16, 'triangle');
    globalThis.setTimeout(() => this.tone(1180, 0.09, 0.14, 'triangle'), 65);
  }

  death(): void {
    const ctx = this.ctx;
    const target = this.destination();
    if (!ctx || !target) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.6);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.26, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.65);
    osc.connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + 0.7);
  }

  hurt(): void {
    this.noiseBurst(0.13, 620, 0.2);
  }

  reloadStart(): void {
    this.tone(320, 0.05, 0.11, 'square');
    globalThis.setTimeout(() => this.tone(240, 0.06, 0.1, 'square'), 120);
  }

  reloadEnd(): void {
    this.tone(520, 0.05, 0.13, 'square');
    globalThis.setTimeout(() => this.tone(700, 0.05, 0.11, 'square'), 70);
  }

  dryFire(): void {
    this.tone(180, 0.035, 0.16, 'square');
  }

  footstep(speed: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime * 1000;
    const interval = Math.max(260, 620 - speed * 42);
    if (now - this.lastFootstepAt < interval) return;
    this.lastFootstepAt = now;
    this.noiseBurst(0.055, 900 + Math.random() * 400, 0.07);
  }

  spawn(): void {
    this.tone(660, 0.12, 0.1, 'sine');
  }

  roundEnd(win: boolean): void {
    const base = win ? 520 : 340;
    this.tone(base, 0.16, 0.16, 'triangle');
    globalThis.setTimeout(() => this.tone(base * (win ? 1.5 : 0.75), 0.3, 0.14, 'triangle'), 150);
  }

  private tone(frequency: number, duration: number, gainValue: number, type: OscillatorType): void {
    const ctx = this.ctx;
    const target = this.destination();
    if (!ctx || !target) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + duration);
    osc.connect(gain).connect(target);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  private noiseBurst(
    duration: number,
    frequency: number,
    gainValue: number,
    position?: Vec3,
  ): void {
    const ctx = this.ctx;
    const noiseBuffer = this.noiseBuffer;
    const target = this.destination(position);
    if (!ctx || !noiseBuffer || !target) return;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 1.1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + duration);
    noise.connect(filter).connect(gain).connect(target);
    noise.start(now);
    noise.stop(now + duration + 0.02);
  }
}
