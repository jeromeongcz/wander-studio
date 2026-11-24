import { randomBytes } from 'node:crypto';

// Crockford base32 ULID: 48-bit timestamp + 80-bit randomness, lexicographically sortable.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom: number[] = [];

function freshRandom(): number[] {
  return Array.from(randomBytes(16), (b) => b & 31);
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // Monotonic within the same millisecond: increment the random part.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] === 31) lastRandom[i] = 0;
      else {
        lastRandom[i]++;
        break;
      }
    }
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + lastRandom.map((n) => ALPHABET[n]).join('');
}
