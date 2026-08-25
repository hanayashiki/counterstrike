/**
 * Tiny binary reader/writer used for the wire protocol. WebSockets already give
 * us ordering and reliability, so all we need here is compactness: snapshots go
 * out 32x a second per client and JSON would be several times larger.
 */

/**
 * A view that is guaranteed to be backed by a plain (non-shared) ArrayBuffer.
 * Both `WebSocket.send` overloads require this, so pinning it here keeps every
 * call site free of casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Positions: 1/1024 m resolution over a +-2000 m range. */
const POS_SCALE = 1024;
/** Velocities: 1/64 m/s resolution over a +-512 m/s range. */
const VEL_SCALE = 64;
const YAW_SCALE = 65536 / (Math.PI * 2);
const PITCH_SCALE = 32767 / (Math.PI / 2);

const clampInt = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : Math.round(v);

export class BinaryWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Bytes;
  private offset = 0;

  constructor(initialCapacity = 1024) {
    this.buffer = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  get length(): number {
    return this.offset;
  }

  reset(): void {
    this.offset = 0;
  }

  private ensure(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < needed) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, v & 0xff);
    this.offset += 1;
    return this;
  }

  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.offset, clampInt(v, -128, 127));
    this.offset += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, v & 0xffff, true);
    this.offset += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.offset, clampInt(v, -32768, 32767), true);
    this.offset += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.offset, clampInt(v, -2147483648, 2147483647), true);
    this.offset += 4;
    return this;
  }

  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  /** LEB128-style variable length unsigned integer. */
  varUint(value: number): this {
    let v = Math.max(0, Math.floor(value));
    do {
      let byte = v & 0x7f;
      v = Math.floor(v / 128);
      if (v > 0) byte |= 0x80;
      this.u8(byte);
    } while (v > 0);
    return this;
  }

  string(value: string): this {
    const encoded = textEncoder.encode(value);
    this.varUint(encoded.length);
    this.ensure(encoded.length);
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.length;
    return this;
  }

  /** Quantized world coordinate. */
  pos(v: number): this {
    return this.i32(v * POS_SCALE);
  }

  vel(v: number): this {
    return this.i16(clampInt(v * VEL_SCALE, -32768, 32767));
  }

  /** Yaw in (-PI, PI] packed into 16 bits. */
  yaw(v: number): this {
    return this.u16(Math.round(v * YAW_SCALE) & 0xffff);
  }

  /** Pitch in [-PI/2, PI/2] packed into 16 bits. */
  pitch(v: number): this {
    return this.i16(clampInt(v * PITCH_SCALE, -32767, 32767));
  }

  finish(): Bytes {
    return this.bytes.slice(0, this.offset);
  }

  /** Zero-copy view of the written bytes; only valid until the next write. */
  subarray(): Bytes {
    return this.bytes.subarray(0, this.offset);
  }
}

export class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    }
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  get done(): boolean {
    return this.offset >= this.view.byteLength;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  varUint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }

  string(): string {
    const length = this.varUint();
    const start = this.offset;
    this.offset += length;
    return textDecoder.decode(this.bytes.subarray(start, start + length));
  }

  pos(): number {
    return this.i32() / POS_SCALE;
  }

  vel(): number {
    return this.i16() / VEL_SCALE;
  }

  yaw(): number {
    let v = this.u16() / YAW_SCALE;
    if (v > Math.PI) v -= Math.PI * 2;
    return v;
  }

  pitch(): number {
    return this.i16() / PITCH_SCALE;
  }
}
