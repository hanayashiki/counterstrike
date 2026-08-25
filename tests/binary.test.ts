import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BinaryReader, BinaryWriter } from '../src/shared/binary';

test('roundtrips every fixed-width integer type', () => {
  const w = new BinaryWriter(8);
  w.u8(0).u8(255).i8(-128).i8(127);
  w.u16(0).u16(65535).i16(-32768).i16(32767);
  w.u32(0).u32(4294967295).i32(-2147483648).i32(2147483647);
  w.bool(true).bool(false);

  const r = new BinaryReader(w.finish());
  assert.equal(r.u8(), 0);
  assert.equal(r.u8(), 255);
  assert.equal(r.i8(), -128);
  assert.equal(r.i8(), 127);
  assert.equal(r.u16(), 0);
  assert.equal(r.u16(), 65535);
  assert.equal(r.i16(), -32768);
  assert.equal(r.i16(), 32767);
  assert.equal(r.u32(), 0);
  assert.equal(r.u32(), 4294967295);
  assert.equal(r.i32(), -2147483648);
  assert.equal(r.i32(), 2147483647);
  assert.equal(r.bool(), true);
  assert.equal(r.bool(), false);
  assert.equal(r.done, true);
});

test('grows past the initial capacity without corrupting earlier writes', () => {
  const w = new BinaryWriter(4);
  for (let i = 0; i < 500; i++) w.u32(i * 7);
  const r = new BinaryReader(w.finish());
  for (let i = 0; i < 500; i++) assert.equal(r.u32(), i * 7);
});

test('varUint spans one to five bytes', () => {
  for (const value of [0, 1, 127, 128, 300, 16383, 16384, 1_000_000, 268_435_455]) {
    const w = new BinaryWriter(8);
    w.varUint(value);
    assert.equal(new BinaryReader(w.finish()).varUint(), value, `value ${value}`);
  }
});

test('strings survive utf-8 round trips', () => {
  for (const value of ['', 'Operator', 'Ünïcødé ✓', '日本語のプレイヤー', 'a'.repeat(300)]) {
    const w = new BinaryWriter(8);
    w.string(value);
    assert.equal(new BinaryReader(w.finish()).string(), value);
  }
});

test('position quantization stays within half a millimetre', () => {
  for (const value of [0, 1, -1, 12.345, -37.891, 512.5, -512.5]) {
    const w = new BinaryWriter(8);
    w.pos(value);
    const decoded = new BinaryReader(w.finish()).pos();
    assert.ok(Math.abs(decoded - value) <= 1 / 2048 + 1e-9, `${value} -> ${decoded}`);
  }
});

test('yaw wraps back into (-PI, PI]', () => {
  for (let angle = -Math.PI; angle <= Math.PI; angle += 0.05) {
    const w = new BinaryWriter(4);
    w.yaw(angle);
    const decoded = new BinaryReader(w.finish()).yaw();
    const delta = Math.abs(Math.atan2(Math.sin(decoded - angle), Math.cos(decoded - angle)));
    assert.ok(delta < 0.0002, `${angle} -> ${decoded}`);
  }
});

test('pitch quantization keeps sub-milliradian accuracy', () => {
  for (const angle of [-1.55, -0.7, 0, 0.33, 1.55]) {
    const w = new BinaryWriter(4);
    w.pitch(angle);
    const decoded = new BinaryReader(w.finish()).pitch();
    assert.ok(Math.abs(decoded - angle) < 0.0001, `${angle} -> ${decoded}`);
  }
});

test('velocity quantization clamps rather than wrapping', () => {
  const w = new BinaryWriter(4);
  w.vel(99999);
  const decoded = new BinaryReader(w.finish()).vel();
  assert.ok(decoded > 0, 'clamped velocity must stay positive');
});

test('reset lets a writer be reused', () => {
  const w = new BinaryWriter(16);
  w.u32(1234);
  w.reset();
  w.u32(5678);
  assert.equal(w.length, 4);
  assert.equal(new BinaryReader(w.finish()).u32(), 5678);
});

test('a reader accepts a subarray view with a non-zero byte offset', () => {
  const backing = new Uint8Array(16);
  const w = new BinaryWriter(8);
  w.u32(0xdeadbeef);
  backing.set(w.finish(), 4);
  const view = backing.subarray(4, 8);
  assert.equal(new BinaryReader(view).u32(), 0xdeadbeef);
});
