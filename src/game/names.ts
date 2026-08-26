/**
 * Bot call-signs, deliberately human-looking so the scoreboard reads naturally.
 * Names are not tied to a character model - any operator can carry any name.
 */
export const BOT_NAMES: readonly string[] = [
  'Vesper',
  'Juno',
  'Nyx',
  'Astra',
  'Lyra',
  'Cyra',
  'Wren',
  'Kestrel',
  'Ghost',
  'Vandal',
  'Nomad',
  'Ripcord',
  'Havoc',
  'Sable',
  'Torque',
  'Vector',
  'Cinder',
  'Onyx',
  'Rook',
  'Quill',
  'Static',
  'Halcyon',
  'Drift',
  'Ember',
  'Wraith',
  'Talon',
  'Corvid',
];

export function pickBotName(taken: ReadonlySet<string>): string {
  for (const name of BOT_NAMES) {
    if (!taken.has(name)) return name;
  }
  for (let i = 2; i < 100; i++) {
    for (const name of BOT_NAMES) {
      const candidate = `${name}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  return `Bot-${taken.size + 1}`;
}
