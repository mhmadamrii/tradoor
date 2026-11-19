/**
 * Hyperliquid's order API, as tradoor speaks it: the wire format of prices and
 * sizes, the actions (order, cancel, modify, leverage, a scheduled cancel), how
 * one is signed by the trading key and sent, and the message the owner's
 * wallet signs once to approve that key. As hyperliquid-python-sdk does it
 * (utils/signing.py, exchange.py), whose test vectors hyperliquid.test.ts checks.
 *
 * Nothing here holds a key or reaches the network; the trade worker does both.
 */
import { pack, type Packable } from './msgpack';
import type { Network, Tif } from './protocol';
import { fromHex, toHex, type Signature, type Signer } from './signer';

export type { Network, Tif };

export const API: Record<Network, { http: string; ws: string; app: string }> = {
  mainnet: { http: 'https://api.hyperliquid.xyz', ws: 'wss://api.hyperliquid.xyz/ws', app: 'https://app.hyperliquid.xyz' },
  testnet: { http: 'https://api.hyperliquid-testnet.xyz', ws: 'wss://api.hyperliquid-testnet.xyz/ws', app: 'https://app.hyperliquid-testnet.xyz' },
};

/** A perpetual as the API numbers it: its place in the list is its asset id. */
export interface Asset {
  name: string;
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

/** `meta`'s universe, delisted coins left out but their numbers kept. */
export function assetsOf(meta: { universe?: { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean; isDelisted?: boolean }[] }): Asset[] {
  return (meta.universe ?? []).flatMap((u, asset) => (u.isDelisted ? [] : [{ name: u.name, asset, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, onlyIsolated: !!u.onlyIsolated }]));
}

/**
 * A price the exchange takes: at most five significant figures and no more
 * than 6 − szDecimals decimals (8 on spot); a whole number always.
 */
export function roundPrice(px: number, szDecimals: number, spot = false): number {
  if (!(px > 0) || !Number.isFinite(px)) return 0;
  if (px >= 1e5) return Math.round(px);
  const decimals = Math.max(0, (spot ? 8 : 6) - szDecimals);
  return Number(Number(px.toPrecision(5)).toFixed(decimals));
}

/** A size to the coin's decimals: down, so that a size worked out from money never comes to more. */
export function roundSize(sz: number, szDecimals: number): number {
  if (!(sz > 0) || !Number.isFinite(sz)) return 0;
  const f = 10 ** szDecimals;
  return Math.floor(sz * f + 1e-9) / f;
}

/** A number as the wire writes it: eight decimals at most, no trailing zeros (`float_to_wire`). */
export function toWire(x: number): string {
  const s = x.toFixed(8).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

// A type, not an interface: it must pass as something MessagePack packs.
export type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
  c?: string;
};

/** An order's wire, its keys in the SDK's order: the hash depends on it. */
export function orderWire(o: { asset: Asset; buy: boolean; price: number; size: number; reduceOnly?: boolean; tif?: Tif; trigger?: { price: number; market: boolean; tpsl: 'tp' | 'sl' }; cloid?: string }): OrderWire {
  const t: OrderWire['t'] = o.trigger ? { trigger: { isMarket: o.trigger.market, triggerPx: toWire(roundPrice(o.trigger.price, o.asset.szDecimals)), tpsl: o.trigger.tpsl } } : { limit: { tif: o.tif ?? 'Gtc' } };
  return { a: o.asset.asset, b: o.buy, p: toWire(roundPrice(o.price, o.asset.szDecimals)), s: toWire(roundSize(o.size, o.asset.szDecimals)), r: !!o.reduceOnly, t, ...(o.cloid ? { c: o.cloid } : {}) };
}

/** `na` alone; `normalTpsl` an entry then its take profit and stop, live once it fills; `positionTpsl` the position's own. */
export type Grouping = 'na' | 'normalTpsl' | 'positionTpsl';

export const actions = {
  order: (orders: OrderWire[], grouping: Grouping = 'na', builder?: { b: string; f: number }) => ({ type: 'order', orders, grouping, ...(builder ? { builder } : {}) }),
  cancel: (cancels: { asset: number; oid: number }[]) => ({ type: 'cancel', cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) }),
  cancelByCloid: (cancels: { asset: number; cloid: string }[]) => ({ type: 'cancelByCloid', cancels: cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) }),
  modify: (oid: number | string, order: OrderWire) => ({ type: 'modify', oid, order }),
  batchModify: (modifies: { oid: number | string; order: OrderWire }[]) => ({ type: 'batchModify', modifies: modifies.map((m) => ({ oid: m.oid, order: m.order })) }),
  leverage: (asset: number, cross: boolean, leverage: number) => ({ type: 'updateLeverage', asset, isCross: cross, leverage: Math.round(leverage) }),
  /** Every open order cancelled at that time unless moved again; `undefined` takes it back. At least 5 s ahead, 10 a day. */
  scheduleCancel: (time?: number) => ({ type: 'scheduleCancel', ...(time !== undefined ? { time } : {}) }),
};

/** An order's id of tradoor's own: 16 bytes, the first two `7d0a` so tradoor knows its own orders. */
export function newCloid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[0] = 0x7d;
  b[1] = 0x0a;
  return `0x${toHex(b)}`;
}

/** Nonces: the time in milliseconds, never the same twice, never going back. */
export class Nonces {
  private last = 0;
  next(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
}

/** A number in hex without its leading zeros, as `to_hex` writes `r` and `s`. */
const word = (b: Uint8Array) => `0x${toHex(b).replace(/^0+(?=.)/, '')}`;

export interface Signed {
  action: Packable;
  nonce: number;
  signature: { r: string; s: string; v: number };
  vaultAddress: string | null;
  expiresAfter: number | null;
}

/** The body `/exchange` takes for an action signed with the trading key. */
export function signAction(signer: Signer, key: Uint8Array, action: Packable, nonce: number, network: Network, vault: string | null = null, expiresAfter: number | null = null): Signed {
  const sig = signer.hyperliquid(pack(action), nonce, vault ? fromHex(vault) : null, expiresAfter, network === 'mainnet', key);
  if (!sig) throw new Error('The trading key is not a key');
  return { action, nonce, signature: { r: word(sig.r), s: word(sig.s), v: sig.v }, vaultAddress: vault, expiresAfter };
}

/** A wallet's 65-byte signature, `0x` r s v, as the API takes it. */
export function splitSignature(hex: string): Signature & { hex: { r: string; s: string; v: number } } {
  const b = fromHex(hex);
  if (b.length !== 65) throw new Error('The wallet gave no signature');
  const v = b[64]! < 27 ? b[64]! + 27 : b[64]!;
  return { r: b.slice(0, 32), s: b.slice(32, 64), v, hex: { r: word(b.slice(0, 32)), s: word(b.slice(32, 64)), v } };
}

/**
 * The message the owner's wallet signs to approve a trading key (EIP-712,
 * `eth_signTypedData_v4`), and the action sent with that signature. The
 * domain's chain is the wallet's own: wallets refuse any other. A name gives
 * the key one of the three named places, and `valid_until` after it an expiry;
 * approving the same name again replaces the key it had.
 */
export function approveAgent(o: { network: Network; walletChain: number; agent: string; name: string; validUntil?: number; nonce: number }) {
  const agentName = o.validUntil ? `${o.name} valid_until ${o.validUntil}` : o.name;
  const hyperliquidChain = o.network === 'mainnet' ? 'Mainnet' : 'Testnet';
  const message = { hyperliquidChain, agentAddress: o.agent.toLowerCase(), agentName, nonce: o.nonce };
  const typed = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: o.walletChain, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message,
  };
  const action = { type: 'approveAgent', signatureChainId: `0x${o.walletChain.toString(16)}`, hyperliquidChain, agentAddress: message.agentAddress, agentName, nonce: o.nonce };
  return { typed, action };
}

/** What `/exchange` answers for an order: each order's fate, in the order sent. */
export type OrderStatus = { resting: { oid: number; cloid?: string } } | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } } | { error: string } | 'success' | 'waitingForFill' | 'waitingForTrigger';

export interface ExchangeReply {
  status: 'ok' | 'err';
  response?: string | { type: string; data?: { statuses?: (OrderStatus | { error: string })[] } };
}

/** The first refusal in a reply, in words; null when everything went through. */
export function refusal(reply: ExchangeReply): string | null {
  if (reply.status !== 'ok') return typeof reply.response === 'string' ? reply.response : 'Refused';
  const statuses = typeof reply.response === 'object' ? (reply.response.data?.statuses ?? []) : [];
  for (const s of statuses) if (typeof s === 'object' && s && 'error' in s) return inWords(s.error);
  return null;
}

/** Hyperliquid's terse refusals said plainly, its own words kept after. */
function inWords(e: string): string {
  // Testnet's book can sit percents away from the oracle (2026-11-15: bid 63,786, oracle 65,507), and
  // a price that far off is refused even at the best bid.
  if (/too far from oracle/i.test(e)) return `The price is too far from Hyperliquid's oracle price, which its book can sit well away from on testnet: a limit nearer the oracle rests until it fills (${e})`;
  return e;
}
