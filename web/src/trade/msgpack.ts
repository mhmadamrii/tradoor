/**
 * MessagePack as Python's `msgpack.packb` writes it, for what Hyperliquid
 * hashes and signs: texts, whole numbers, true and false, null, lists, and maps
 * in the order their keys were written. A key whose value is `undefined` is
 * left out, as JSON leaves it out. A number with a fraction is refused: an
 * action carries prices and sizes as text, and a float would hash differently.
 */
export type Packable = string | number | boolean | null | readonly Packable[] | { readonly [key: string]: Packable | undefined };

const text = new TextEncoder();

export function pack(value: Packable): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return Uint8Array.from(out);
}

function be(out: number[], n: number, bytes: number) {
  for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
}

function write(v: Packable | undefined, out: number[]): void {
  if (v === null || v === undefined) out.push(0xc0);
  else if (v === true) out.push(0xc3);
  else if (v === false) out.push(0xc2);
  else if (typeof v === 'string') {
    const b = text.encode(v);
    const n = b.length;
    if (n < 32) out.push(0xa0 | n);
    else if (n < 0x100) out.push(0xd9, n);
    else if (n < 0x10000) (out.push(0xda), be(out, n, 2));
    else (out.push(0xdb), be(out, n, 4));
    for (const x of b) out.push(x);
  } else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`not a whole number to sign: ${v}`);
    if (v >= 0) {
      if (v < 0x80) out.push(v);
      else if (v < 0x100) out.push(0xcc, v);
      else if (v < 0x10000) (out.push(0xcd), be(out, v, 2));
      else if (v < 0x1_0000_0000) (out.push(0xce), be(out, v, 4));
      else (out.push(0xcf), be(out, v, 8));
    } else if (v >= -32) out.push(0x100 + v);
    else if (v >= -0x80) out.push(0xd0, 0x100 + v);
    else if (v >= -0x8000) (out.push(0xd1), be(out, 0x10000 + v, 2));
    else if (v >= -0x8000_0000) (out.push(0xd2), be(out, 0x1_0000_0000 + v, 4));
    else {
      // Two's complement in eight bytes: the high four and the low four apart.
      const hi = Math.floor(v / 0x1_0000_0000);
      out.push(0xd3);
      be(out, hi >>> 0, 4);
      be(out, (v - hi * 0x1_0000_0000) >>> 0, 4);
    }
  } else if (Array.isArray(v)) {
    const n = v.length;
    if (n < 16) out.push(0x90 | n);
    else if (n < 0x10000) (out.push(0xdc), be(out, n, 2));
    else (out.push(0xdd), be(out, n, 4));
    for (const x of v) write(x, out);
  } else {
    const entries = Object.entries(v as Record<string, Packable | undefined>).filter(([, x]) => x !== undefined);
    const n = entries.length;
    if (n < 16) out.push(0x80 | n);
    else if (n < 0x10000) (out.push(0xde), be(out, n, 2));
    else (out.push(0xdf), be(out, n, 4));
    for (const [k, x] of entries) {
      write(k, out);
      write(x, out);
    }
  }
}
