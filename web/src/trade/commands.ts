/**
 * Trading by typing, in the Commands palette (and from hotkeys): a line is
 * read into what it will do, shown in words before Enter sends it.
 *
 *   buy 0.01 btc                         at the market, on the default account
 *   sell $500 eth @mid post              a post-only limit at the middle of the book
 *   long 25% @-0.5% tp 2% sl 1%           a quarter of the most it can buy, 0.5% under the bid,
 *                                          a take profit 2% and a stop 1% from its price
 *   stop sell 0.1 btc at 60000 [limit 59900]
 *   close [btc|all] [50%] · flat · reverse · cancel [btc|all] [buys|sells]
 *   lev 10x [iso] · tp 66000 [sl 59000] · sl 59000 · bump [buys|sells] -0.2%|+5
 *   chase buy $1000 [aggr|back 2|stalk 0.5% [trail]] [to 0.5%|until] [for 5m] [then keep|market]
 *   twap sell 1 eth over 30m [x12] [jitter 20%] [uneven 10%] [chase 50% [next]] [between 1700 1800 [abort]]
 *   scale buy 1 btc from 60000 to 58000 [x10] [skew 0.5] [sizes -0.5] [post]
 *   swarm buy 2 sol [x5] [uneven 30%]
 *   … on <account>                        on the account of that name
 *
 * Lines join with `;`. `let size = 0.01` names a value for `$size`; `alias
 * scalp = buy $500 @mid post` names a line, typed as `scalp`; `bind alt+b =
 * buy $500` puts a line on a key; `repeat 3 every 10s <line>` does it again.
 * The coin, when not typed, is the focused panel's.
 */
import { readJson, writePref } from '../lib/prefs';
import { TIMEFRAMES, type AccountRef, type AlgoSpec, type BoundsAction, type Condition, type Guards, type MarketInfo, type OpenOrder, type OrderRequest, type Position, type Tif, type Timeframe } from './protocol';

export interface Ctx {
  accounts: AccountRef[];
  /** The account a line trades on when it does not say: the last one used. */
  defaultAccount?: string;
  markets(a: AccountRef): Map<string, MarketInfo> | undefined;
  book(a: AccountRef, coin: string): { bid: number; ask: number } | undefined;
  position(a: AccountRef, coin: string): Position | undefined;
  orders(a: AccountRef): OpenOrder[];
  maxSize(a: AccountRef, coin: string, buy: boolean): number;
  /** The focused panel's market, for the coin. */
  market: string | null;
  coinOf(market: string, known: Map<string, MarketInfo> | undefined): string | null;
  guards: Guards;
}

export type Action =
  | { kind: 'order'; account: AccountRef; req: Omit<OrderRequest, 'guards'>; worth: number }
  | { kind: 'algo'; account: AccountRef; spec: AlgoSpec; worth: number }
  | { kind: 'flatten'; account: AccountRef; coin: string | null }
  | { kind: 'close'; account: AccountRef; coin: string; fraction: number; buy: boolean; size: number }
  | { kind: 'cancel'; account: AccountRef; orders: { coin: string; oid: number }[] }
  | { kind: 'leverage'; account: AccountRef; coin: string; leverage: number; cross: boolean }
  | { kind: 'exits'; account: AccountRef; coin: string; tp: number | null; sl: number | null }
  | { kind: 'move'; account: AccountRef; moves: { order: OpenOrder; price: number }[] }
  | { kind: 'alias'; name: string; text: string }
  | { kind: 'let'; name: string; value: string }
  | { kind: 'bind'; key: string; text: string | null }
  | { kind: 'repeat'; times: number; every: number; line: string };

/** `want`: a line waiting on a price names the book it needs, so it can be followed and the line read again. */
export type Read = { actions: Action[]; label: string } | { error: string; want?: { account: AccountRef; coin: string } };

const ALIASES = 'tradeAliases';
const VARS = 'tradeVars';
export const BINDS = 'tradeBinds';

const store = (key: string): Record<string, string> => {
  const v = readJson(key);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
};
export const aliases = () => store(ALIASES);
export const vars = () => store(VARS);
export const binds = () => store(BINDS);
const save = (key: string, name: string, value: string | null) => {
  const all = store(key);
  if (value === null) delete all[name];
  else all[name] = value;
  writePref(key, JSON.stringify(all));
};

/** Whether a line looks like trading, so the palette loads this module for it. */
export const TRADING_WORDS = /^\s*(buy|sell|long|short|stop|close|flat|flatten|reverse|cancel|lev|leverage|tp|sl|bump|chase|twap|scale|swarm|alias|let|bind|unbind|repeat|when|if|at)\b/i;

// ---- reading numbers, sizes, prices, times ------------------------------------

/** 1500, 1.5k, 2m: a number with an optional thousand or million. */
function number(t: string | undefined): number | null {
  if (!t) return null;
  const m = /^([+-]?\d*\.?\d+(?:e-?\d+)?)([km])?$/i.exec(t.replace(/,/g, ''));
  if (!m) return null;
  return Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1e3 : m[2]?.toLowerCase() === 'm' ? 1e6 : 1);
}

const pctOf = (t: string | undefined) => (t?.endsWith('%') ? number(t.slice(0, -1)) : null);

/** 30m, 2h, 90s, 1h30m: milliseconds. */
function duration(t: string | undefined): number | null {
  if (!t) return null;
  const re = /(\d*\.?\d+)\s*(h|m|s)/gi;
  let ms = 0;
  let any = false;
  for (const m of t.matchAll(re)) {
    any = true;
    ms += Number(m[1]) * (m[2]!.toLowerCase() === 'h' ? 3_600_000 : m[2]!.toLowerCase() === 'm' ? 60_000 : 1000);
  }
  return any && t.replace(re, '') === '' ? ms : null;
}

type Size = { coins: number } | { usd: number } | { share: number };

function size(t: string | undefined): Size | null {
  if (!t) return null;
  const usd = /^\$(.+)$/.exec(t) ?? /^(.+?)(\$|usd|usdc|usdt)$/i.exec(t);
  if (usd) {
    const n = number(usd[1]);
    return n !== null && n > 0 ? { usd: n } : null;
  }
  const p = pctOf(t);
  if (p !== null) return p > 0 && p <= 100 ? { share: p / 100 } : null;
  const n = number(t);
  return n !== null && n > 0 ? { coins: n } : null;
}

/** A price: a number, the book's bid, ask or middle, or a move from the best on the order's side. */
function priceOf(t: string, book: { bid: number; ask: number } | undefined, buy: boolean): number | null {
  const v = t.replace(/^@/, '');
  if (v === 'bid' || v === 'ask' || v === 'mid' || v === 'best') {
    if (!book) return null;
    return v === 'bid' ? book.bid : v === 'ask' ? book.ask : v === 'mid' ? (book.bid + book.ask) / 2 : buy ? book.bid : book.ask;
  }
  if (/^[+-]/.test(v)) {
    if (!book) return null;
    const ref = buy ? book.bid : book.ask;
    const p = pctOf(v);
    if (p !== null) return ref * (1 + p / 100);
    const n = number(v);
    return n === null ? null : ref + n;
  }
  const n = number(v);
  return n !== null && n > 0 ? n : null;
}

/** A take profit or stop: a price, or a percentage from the order's price — unsigned, the way it pays (tp) or loses (sl). */
function exitOf(t: string | undefined, ref: number, buy: boolean, tp: boolean): number | null {
  if (!t) return null;
  const p = pctOf(t);
  if (p !== null) {
    if (/^[+-]/.test(t)) return ref * (1 + p / 100);
    const up = tp === buy;
    return ref * (1 + ((up ? 1 : -1) * p) / 100);
  }
  const n = number(t);
  return n !== null && n > 0 ? n : null;
}

// ---- reading a line -----------------------------------------------------------

/** `$name` replaced by its value, and a first word that is an alias by its line. */
export function expand(line: string): string {
  const v = vars();
  let out = line.replace(/\$([a-z_][\w]*)/gi, (all, name: string) => v[name.toLowerCase()] ?? all);
  const a = aliases();
  const first = out.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (a[first]) out = `${a[first]} ${out.trim().slice(first.length)}`.trim();
  return out;
}

const fmt = (n: number, d = 6) => Number(n.toPrecision(d)).toLocaleString('en-US', { maximumFractionDigits: 8 });

/** Reads a line, `;` and all; what it will do, in words, or why it cannot. */
export function read(input: string, ctx: Ctx): Read {
  const parts = input.split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: 'Nothing to do' };
  const actions: Action[] = [];
  const labels: string[] = [];
  for (const part of parts) {
    const r = readOne(part, ctx);
    if ('error' in r) return r;
    actions.push(...r.actions);
    labels.push(r.label);
  }
  return { actions, label: labels.join('; then ') };
}

function readOne(raw: string, ctx: Ctx): Read {
  // Definitions keep their right-hand side as typed.
  const def = /^(alias|let|bind)\s+(\S+)\s*=\s*(.+)$/i.exec(raw.trim());
  if (def) {
    const [, what, nameRaw, rest] = def;
    const name = nameRaw!.toLowerCase();
    if (what!.toLowerCase() === 'alias') {
      if (TRADING_WORDS.test(name) || !/^[a-z]\w*$/.test(name)) return { error: `${name}: an alias is one word, not one of the command words` };
      return { actions: [{ kind: 'alias', name, text: rest!.trim() }], label: `Remember ${name} as “${rest!.trim()}”` };
    }
    if (what!.toLowerCase() === 'let') {
      if (!/^[a-z_]\w*$/.test(name)) return { error: `${name}: a name is letters, digits and _` };
      return { actions: [{ kind: 'let', name, value: rest!.trim() }], label: `$${name} is ${rest!.trim()}` };
    }
    const key = normalKey(name);
    if (!key) return { error: `${nameRaw}: a key is like alt+1, ctrl+shift+b or f2` };
    if (TAKEN[key]) return { error: `${key} is taken: ${TAKEN[key]}` };
    return { actions: [{ kind: 'bind', key, text: rest!.trim() }], label: `${key} runs “${rest!.trim()}”` };
  }
  const unbind = /^unbind\s+(\S+)$/i.exec(raw.trim());
  if (unbind) {
    const key = normalKey(unbind[1]!.toLowerCase());
    return key ? { actions: [{ kind: 'bind', key, text: null }], label: `${key} runs nothing` } : { error: 'Not a key' };
  }
  const rep = /^repeat\s+(\d+)\s+(?:times\s+)?every\s+(\S+)\s+(.+)$/i.exec(raw.trim());
  if (rep) {
    const times = Math.min(100, Number(rep[1]));
    const every = duration(rep[2]);
    if (!(times >= 2) || !every || every < 1000) return { error: 'repeat 3 every 10s <line>: two times at least, a second apart at least' };
    const inner = readOne(expand(rep[3]!), ctx);
    if ('error' in inner) return inner;
    return { actions: [{ kind: 'repeat', times, every, line: rep[3]! }], label: `${inner.label}, ${times} times, every ${rep[2]}` };
  }

  // Held until conditions are met: `when btc > 70000 and 4h btc close > 69000: buy 0.1 eth`, `at 20:00: …`.
  // The colon that ends the conditions has a space after it; a time's own (20:00) has none.
  const cond = /^(?:(when|if)\s+(.+?)|at\s+((?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}))\s*:\s+(.+)$/i.exec(raw.trim());
  if (cond) {
    const inner = readOne(cond[4]!, ctx);
    if ('error' in inner) return inner;
    const act = inner.actions[0];
    if (inner.actions.length !== 1 || !act || (act.kind !== 'order' && act.kind !== 'algo') || (act.kind === 'algo' && act.spec.kind === 'when')) return { error: 'After the colon: one order or one algorithm' };
    const text = cond[2] ?? `time ${cond[3]}`;
    const join: 'and' | 'or' = /\s+or\s+/i.test(text) ? 'or' : 'and';
    const parts = text.split(/\s+(?:and|or)\s+/i);
    if (parts.length > 5) return { error: 'Five conditions at most' };
    const known = ctx.markets(act.account);
    const conditions: Condition[] = [];
    for (const p of parts) {
      const c = conditionOf(p.trim().toLowerCase(), known);
      if (typeof c === 'string') return { error: c };
      conditions.push(c);
    }
    const base = act.kind === 'order' ? { coin: act.req.coin, buy: act.req.buy, size: act.req.size, reduceOnly: !!act.req.reduceOnly } : { coin: act.spec.coin, buy: act.spec.buy, size: act.spec.size, reduceOnly: act.spec.reduceOnly };
    const spec: AlgoSpec = { kind: 'when', account: act.account.id, ...base, conditions, join, then: act.kind === 'order' ? { kind: 'order', req: act.req } : { kind: 'algo', spec: act.spec as Exclude<AlgoSpec, { kind: 'when' }> } };
    return { actions: [{ kind: 'algo', account: act.account, spec, worth: act.worth }], label: `When ${conditions.map(describeCondition).join(` ${join} `)}: ${inner.label.replace(/^./, (x) => x.toLowerCase())}` };
  }

  const words = expand(raw).toLowerCase().split(/\s+/).filter(Boolean);
  // The account first: its exchange says which coins there are.
  let account: AccountRef | undefined;
  const on = words.indexOf('on');
  if (on >= 0) {
    const name = words.slice(on + 1).join(' ');
    words.splice(on);
    account = ctx.accounts.find((a) => a.label.toLowerCase() === name) ?? ctx.accounts.find((a) => a.label.toLowerCase().startsWith(name));
    if (!account) return { error: `No account called “${name}”` };
  }
  account ??= ctx.accounts.find((a) => a.id === ctx.defaultAccount && a.mode === 'trade') ?? ctx.accounts.find((a) => a.mode === 'trade');
  if (!account) return { error: 'No account with a key to trade with: add one in a Trade panel' };
  const a = account;
  const known = ctx.markets(a);
  const coinWord = (w: string) => {
    if (!known) return null;
    const base = w.toUpperCase().replace(/[-_]?(PERP)$/, '').replace(/(USDT|USDC|USD)$/, '');
    if (known.has(base)) return base;
    const k = `k${base.replace(/^1000/, '')}`;
    if (base.startsWith('1000') || base.startsWith('K')) {
      const named = [...known.keys()].find((c) => c.toUpperCase() === k.toUpperCase() || c.toUpperCase() === base);
      if (named) return named;
    }
    return [...known.keys()].find((c) => c.toUpperCase() === base) ?? null;
  };
  // A coin anywhere in the line; else the focused panel's.
  let coin: string | null = null;
  for (let i = 1; i < words.length; i++) {
    const c = coinWord(words[i]!);
    if (c && !size(words[i]) && number(words[i]) === null) {
      coin = c;
      words.splice(i, 1);
      break;
    }
  }
  coin ??= ctx.market ? ctx.coinOf(ctx.market, known) : null;
  const where = ` · ${a.label}`;
  const verb = words[0]!;
  const need = () => (coin ? null : { error: known ? 'Which coin? Type it, or focus a panel on one' : `Reading ${a.label}'s markets…` });
  const m = coin ? known?.get(coin) : undefined;
  const book = coin ? ctx.book(a, coin) : undefined;
  const has = (w: string) => words.includes(w);
  const after = (w: string) => {
    const i = words.indexOf(w);
    return i >= 0 ? words[i + 1] : undefined;
  };

  const coinsOf = (s: Size, buy: boolean, at: number): number | null => {
    if ('coins' in s) return s.coins;
    if ('usd' in s) return at > 0 ? s.usd / at : null;
    const max = ctx.maxSize(a, coin!, buy);
    return max > 0 ? max * s.share : null;
  };
  const sizeLabel = (n: number, at: number) => `${fmt(n, 6)} ${coin}${at > 0 ? ` (≈ $${fmt(n * at, 6)})` : ''}`;

  switch (verb) {
    case 'buy':
    case 'long':
    case 'sell':
    case 'short': {
      const no = need();
      if (no) return no;
      const buy = verb === 'buy' || verb === 'long';
      const s = size(words[1]);
      if (!s) return { error: `${verb} <size>: 0.01, $500 or 25%` };
      const at = words.find((w) => w.startsWith('@'));
      const limit = at ? priceOf(at, book, buy) : null;
      if (at && limit === null) return { error: `${at}: not a price${book ? '' : ' (the book is not read yet)'}`, want: { account: a, coin: coin! } };
      const ref = limit ?? (book ? (buy ? book.ask : book.bid) : 0);
      const n = coinsOf(s, buy, ref);
      if (n === null) return { error: book ? 'No size: the account cannot buy any' : 'The price is not read yet: try again in a moment', want: { account: a, coin: coin! } };
      const tif: Tif = has('post') || has('po') || has('alo') ? 'Alo' : has('ioc') ? 'Ioc' : 'Gtc';
      const tpRef = ref || (book ? (book.bid + book.ask) / 2 : 0);
      const tp = exitOf(after('tp'), tpRef, buy, true);
      const sl = exitOf(after('sl'), tpRef, buy, false);
      const reduceOnly = has('reduce') || has('ro');
      const req: Omit<OrderRequest, 'guards'> = { coin: coin!, buy, size: n, kind: limit !== null ? 'limit' : 'market', ...(limit !== null ? { price: limit, tif } : {}), reduceOnly, ...(tp ? { tp } : {}), ...(sl ? { sl } : {}) };
      const label = `${buy ? 'Buy' : 'Sell'} ${sizeLabel(n, ref)} ${limit !== null ? `@ ${fmt(limit)}${tif === 'Alo' ? ' post-only' : tif === 'Ioc' ? ' IOC' : ''}` : 'at the market'}${reduceOnly ? ', reduce-only' : ''}${tp ? `, TP ${fmt(tp)}` : ''}${sl ? `, SL ${fmt(sl)}` : ''}${where}`;
      return { actions: [{ kind: 'order', account: a, req, worth: n * ref }], label };
    }
    case 'stop': {
      const no = need();
      if (no) return no;
      const side = words[1];
      if (side !== 'buy' && side !== 'sell' && side !== 'long' && side !== 'short') return { error: 'stop buy|sell <size> at <price> [limit <price>]' };
      const buy = side === 'buy' || side === 'long';
      const s = size(words[2]);
      const trigger = after('at') ? priceOf(after('at')!, book, buy) : null;
      if (!s || !trigger) return { error: 'stop buy|sell <size> at <price> [limit <price>]' };
      const limit = after('limit') ? priceOf(after('limit')!, book, buy) : null;
      const n = coinsOf(s, buy, trigger);
      if (n === null) return { error: 'No size' };
      const req: Omit<OrderRequest, 'guards'> = { coin: coin!, buy, size: n, kind: limit ? 'stopLimit' : 'stop', trigger, ...(limit ? { price: limit } : {}), reduceOnly: has('reduce') || has('ro') };
      return { actions: [{ kind: 'order', account: a, req, worth: n * trigger }], label: `Stop ${buy ? 'buy' : 'sell'} ${sizeLabel(n, trigger)} at ${fmt(trigger)}${limit ? `, then a limit at ${fmt(limit)}` : ', then at the market'}${where}` };
    }
    case 'close': {
      if (words[1] === 'all' || (!coin && !words[1])) return { actions: [{ kind: 'flatten', account: a, coin: null }], label: `Close every position and cancel every order${where}` };
      const no = need();
      if (no) return no;
      const p = ctx.position(a, coin!);
      if (!p) return { error: `No ${coin} position${where}` };
      const share = pctOf(words.find((w) => w.endsWith('%')));
      if (share !== null && share < 100) {
        const fraction = Math.max(0, share) / 100;
        return { actions: [{ kind: 'close', account: a, coin: coin!, fraction, buy: p.size < 0, size: Math.abs(p.size) * fraction }], label: `Close ${share}% of the ${coin} ${p.size > 0 ? 'long' : 'short'} (${fmt(Math.abs(p.size) * fraction)} ${coin}) at the market${where}` };
      }
      return { actions: [{ kind: 'flatten', account: a, coin: coin! }], label: `Close the ${coin} ${p.size > 0 ? 'long' : 'short'} at the market, and its TP / SL${where}` };
    }
    case 'flat':
    case 'flatten':
      if (words[1] === 'all' || !coin) return { actions: [{ kind: 'flatten', account: a, coin: null }], label: `Close every position and cancel every order${where}` };
      {
        // Flat on the coin: its resting orders cancelled too, which a close alone keeps.
        const resting = ctx.orders(a).filter((o) => o.coin === coin && !o.reduceOnly).map((o) => ({ coin: o.coin, oid: o.oid }));
        return { actions: [...(resting.length ? [{ kind: 'cancel' as const, account: a, orders: resting }] : []), { kind: 'flatten', account: a, coin }], label: `Close ${coin} and cancel its orders${where}` };
      }
    case 'reverse': {
      const no = need();
      if (no) return no;
      const p = ctx.position(a, coin!);
      if (!p) return { error: `No ${coin} position to reverse${where}` };
      const ref = book ? (p.size < 0 ? book.ask : book.bid) : p.entry;
      return { actions: [{ kind: 'order', account: a, req: { coin: coin!, buy: p.size < 0, size: Math.abs(p.size) * 2, kind: 'market' }, worth: Math.abs(p.size) * 2 * ref }], label: `Reverse the ${coin} ${p.size > 0 ? 'long into a short' : 'short into a long'}: ${fmt(Math.abs(p.size) * 2)} ${coin} at the market${where}` };
    }
    case 'cancel': {
      const all = words[1] === 'all' || !coin;
      const side = has('buys') ? true : has('sells') ? false : null;
      const list = ctx.orders(a).filter((o) => (all || o.coin === coin) && (side === null || o.buy === side));
      if (!list.length) return { error: `No ${all ? '' : `${coin} `}orders to cancel${where}` };
      return { actions: [{ kind: 'cancel', account: a, orders: list.map((o) => ({ coin: o.coin, oid: o.oid })) }], label: `Cancel ${list.length} ${all ? '' : `${coin} `}${side === null ? '' : side ? 'buy ' : 'sell '}order${list.length > 1 ? 's' : ''}${where}` };
    }
    case 'lev':
    case 'leverage': {
      const no = need();
      if (no) return no;
      const n = number(words[1]?.replace(/x$/, ''));
      if (!n || n < 1) return { error: 'lev 10x [iso|cross]' };
      const cross = !(has('iso') || has('isolated'));
      return { actions: [{ kind: 'leverage', account: a, coin: coin!, leverage: Math.round(n), cross }], label: `${coin} ${cross ? 'cross' : 'isolated'} ${Math.round(n)}×${m && n > m.maxLeverage ? ` (at most ${m.maxLeverage}×)` : ''}${where}` };
    }
    case 'tp':
    case 'sl': {
      const no = need();
      if (no) return no;
      const p = ctx.position(a, coin!);
      if (!p) return { error: `No ${coin} position to protect${where}` };
      const buy = p.size > 0;
      const tp = exitOf(after('tp'), p.entry, buy, true);
      const sl = exitOf(after('sl'), p.entry, buy, false);
      if (!tp && !sl) return { error: 'tp <price> [sl <price>]: a price, or a percentage from the entry' };
      return { actions: [{ kind: 'exits', account: a, coin: coin!, tp, sl }], label: `${coin}: ${tp ? `take profit ${fmt(tp)}` : ''}${tp && sl ? ', ' : ''}${sl ? `stop ${fmt(sl)}` : ''}${where}` };
    }
    case 'bump': {
      const amount = words.find((w, i) => i > 0 && (/^[+-]/.test(w) || w.endsWith('%')));
      if (!amount) return { error: 'bump [buys|sells] -0.2% or +5' };
      const side = has('buys') ? true : has('sells') ? false : null;
      const list = ctx.orders(a).filter((o) => o.trigger === null && (!coin || o.coin === coin) && (side === null || o.buy === side));
      if (!list.length) return { error: `No orders to move${where}` };
      const p = pctOf(amount);
      const n = number(amount);
      const moves = list.map((o) => ({ order: o, price: p !== null ? o.price * (1 + p / 100) : o.price + (n ?? 0) }));
      return { actions: [{ kind: 'move', account: a, moves }], label: `Move ${list.length} order${list.length > 1 ? 's' : ''} by ${amount}${where}` };
    }
    case 'chase':
    case 'twap':
    case 'scale':
    case 'swarm': {
      const no = need();
      if (no) return no;
      const side = words[1];
      if (side !== 'buy' && side !== 'sell' && side !== 'long' && side !== 'short') return { error: `${verb} buy|sell <size> …` };
      const buy = side === 'buy' || side === 'long';
      const s = size(words[2]);
      if (!s) return { error: `${verb} ${side} <size>: 0.01, $500 or 25%` };
      const ref = book ? (buy ? book.ask : book.bid) : 0;
      const n = coinsOf(s, buy, ref || (verb === 'scale' ? (number(after('from')) ?? 0) : 0));
      if (n === null) return { error: 'The price is not read yet: try again in a moment', ...(coin ? { want: { account: a, coin } } : {}) };
      const base = { account: a.id, coin: coin!, buy, size: n, reduceOnly: has('reduce') || has('ro') };
      const count = number(words.find((w) => /^x\d+$/.test(w))?.slice(1)) ?? number(after('in'));
      if (verb === 'chase') {
        const stalk = after('stalk');
        const dist = pctOf(stalk);
        const back = number(after('back'));
        const to = pctOf(after('to'));
        const forMs = duration(after('for'));
        const then = after('then');
        const spec: AlgoSpec = { ...base, kind: 'chase', aggressive: has('aggr') || has('aggressive'), offset: back ?? 0, stalk: dist !== null ? { mode: has('trail') ? 'trail' : 'maintain', distance: dist / 100 } : null, chaseTo: has('until') ? 0 : to !== null ? to / 100 : 0.005, minutes: forMs ? forMs / 60_000 : 0, onEnd: then === 'keep' ? 'keep' : then === 'market' ? 'market' : 'cancel' };
        const how = spec.stalk ? `stalking ${dist}% off${spec.stalk.mode === 'trail' ? ', closing only' : ''}` : spec.aggressive ? 'one tick inside the spread' : back ? `${back} ticks back` : 'at the best price';
        return { actions: [{ kind: 'algo', account: a, spec, worth: n * ref }], label: `Chase ${buy ? 'buy' : 'sell'} ${sizeLabel(n, ref)}, ${how}, ${spec.chaseTo ? `to ${spec.chaseTo * 100}%` : 'until filled'}${forMs ? `, for ${after('for')}` : ''}, then ${spec.onEnd === 'keep' ? 'left resting' : spec.onEnd === 'market' ? 'the rest at the market' : 'cancelled'}${where}` };
      }
      if (verb === 'twap') {
        const over = duration(after('over'));
        if (!over) return { error: 'twap buy|sell <size> over 30m [x12]' };
        const lots = Math.max(2, Math.round(count ?? Math.max(2, Math.min(60, over / 60_000))));
        const chased = has('chase');
        const between = words.indexOf('between');
        const lo = between >= 0 ? number(words[between + 1]) : null;
        const hi = between >= 0 ? number(words[between + 2]) : null;
        const action = (['pause', 'abort', 'finish', 'close'] as BoundsAction[]).find((w) => has(w)) ?? 'pause';
        const spec: AlgoSpec = { ...base, kind: 'twap', minutes: over / 60_000, lots, jitter: Math.min(0.5, (pctOf(after('jitter')) ?? 0) / 100), irregular: Math.min(0.9, (pctOf(after('uneven')) ?? 0) / 100), bounds: lo && hi && hi > lo ? { low: lo, high: hi, action } : null, slice: chased ? 'chase' : 'market', timeout: Math.min(0.95, Math.max(0.05, (pctOf(after('chase')) ?? 50) / 100)), onTimeout: has('next') ? 'next' : 'market' };
        return { actions: [{ kind: 'algo', account: a, spec, worth: n * ref }], label: `TWAP ${buy ? 'buy' : 'sell'} ${sizeLabel(n, ref)} over ${after('over')} in ${lots} slices${spec.jitter ? `, jitter ${spec.jitter * 100}%` : ''}${spec.irregular ? `, uneven ${spec.irregular * 100}%` : ''}${chased ? ', each chased first' : ''}${spec.bounds ? `, between ${lo} and ${hi} (${action} outside)` : ''}${where}` };
      }
      if (verb === 'scale') {
        const from = after('from') ? priceOf(after('from')!, book, buy) : null;
        const to = after('to') ? priceOf(after('to')!, book, buy) : null;
        if (!from || !to) return { error: 'scale buy|sell <size> from <price> to <price> [x10]' };
        const spec: AlgoSpec = { ...base, kind: 'scale', from, to, count: Math.max(2, Math.min(100, Math.round(count ?? 10))), priceSkew: Math.max(-1, Math.min(1, number(after('skew')) ?? 0)), sizeSkew: Math.max(-1, Math.min(1, number(after('sizes')) ?? 0)), postOnly: !has('gtc') };
        return { actions: [{ kind: 'algo', account: a, spec, worth: n * Math.max(from, to) }], label: `Scale ${buy ? 'buy' : 'sell'} ${sizeLabel(n, (from + to) / 2)} in ${spec.count} orders from ${fmt(from)} to ${fmt(to)}${spec.priceSkew ? `, prices bunched ${spec.priceSkew > 0 ? 'to the far end' : 'to the near end'}` : ''}${where}` };
      }
      const spec: AlgoSpec = { ...base, kind: 'swarm', lots: Math.max(2, Math.min(50, Math.round(count ?? 5))), irregular: Math.min(0.9, (pctOf(after('uneven')) ?? 0) / 100) };
      return { actions: [{ kind: 'algo', account: a, spec, worth: n * ref }], label: `Swarm ${buy ? 'buy' : 'sell'} ${sizeLabel(n, ref)} as ${spec.lots} market slices${where}` };
    }
  }
  return { error: `“${verb}”: not a command` };
}

const coinIn = (w: string, known: Map<string, MarketInfo> | undefined) => {
  if (!known) return null;
  const base = w.toUpperCase().replace(/(USDT|USDC|USD)$/, '');
  return [...known.keys()].find((c) => c.toUpperCase() === base || c.toUpperCase() === `K${base.replace(/^1000/, '')}`) ?? null;
};

/** One condition, as typed: `btc > 70000`, `btc/eth < 30`, `4h btc close > 69000`, `1h sol volume > 2m`, `time 20:00`. */
export function conditionOf(t: string, known: Map<string, MarketInfo> | undefined): Condition | string {
  const op = (s: string) => (/^(>|>=|above|over)$/.test(s) ? true : /^(<|<=|below|under)$/.test(s) ? false : null);
  const time = /^(?:time\s*(?:>=|>)?\s*|at\s+)?(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})$/.exec(t);
  if (time) {
    const d = time[1] ? new Date(`${time[1]}T00:00`) : new Date();
    d.setHours(Number(time[2]), Number(time[3]), 0, 0);
    // A time of day already past today: tomorrow's.
    if (!time[1] && d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return { kind: 'time', at: d.getTime() };
  }
  const candle = /^(\d+[a-z]+)\s+(\S+)\s+(close|volume)\s*(>=|<=|>|<|above|over|below|under)\s*(\S+)$/.exec(t);
  if (candle) {
    const tf = candle[1] as Timeframe;
    if (!TIMEFRAMES.includes(tf)) return `${candle[1]}: a timeframe of ${TIMEFRAMES.join(', ')}`;
    const coin = coinIn(candle[2]!, known);
    const v = number(candle[5]!.replace(/^\$/, ''));
    if (!coin || v === null) return `“${t}”: which coin, and what level?`;
    return { kind: candle[3] === 'close' ? 'close' : 'volume', coin, tf, above: op(candle[4]!)!, value: v };
  }
  const plain = /^(\S+?)(?:\/(\S+))?\s*(>=|<=|>|<|above|over|below|under)\s*(\S+)$/.exec(t);
  if (plain) {
    const coin = coinIn(plain[1]!, known);
    const of = plain[2] ? coinIn(plain[2], known) : null;
    const v = number(plain[4]!);
    if (!coin || (plain[2] && !of) || v === null) return `“${t}”: which coin, and what level?`;
    return of ? { kind: 'ratio', coin, of, above: op(plain[3]!)!, value: v } : { kind: 'price', coin, above: op(plain[3]!)!, value: v };
  }
  return `“${t}”: a condition is like btc > 70000, btc/eth < 30, 4h btc close > 69000, 1h sol volume > 2m, or 20:00`;
}

export function describeCondition(c: Condition): string {
  const o = 'above' in c ? (c.above ? '>' : '<') : '';
  if (c.kind === 'time') return `it is ${new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  if (c.kind === 'ratio') return `${c.coin}/${c.of} ${o} ${c.value}`;
  if (c.kind === 'close') return `a ${c.tf} ${c.coin} candle closes ${o} ${c.value}`;
  if (c.kind === 'volume') return `${c.tf} ${c.coin} volume ${o} $${c.value.toLocaleString('en-US')}`;
  return `${c.coin} ${o} ${c.value}`;
}

/** tradoor's own keys, which a binding may not take. */
const TAKEN: Record<string, string> = {
  ...Object.fromEntries(['t', 'h', 'j', 'r', 'c', 'f', 'n', 'm', 'l', 's', 'b', 'p'].map((c) => [`alt+${c}`, 'a drawing tool'])),
  'alt+g': 'the magnet',
  'alt+k': 'the chart picture',
  'alt+enter': 'the chart alone',
  'ctrl+z': 'undo',
  'ctrl+y': 'redo',
  'ctrl+shift+z': 'redo',
  'ctrl+s': 'save',
  'ctrl+k': 'Commands',
};

/** A key as bound: ctrl, alt, shift, meta, then the key itself. Null for anything else. */
export function normalKey(t: string): string | null {
  const parts = t.toLowerCase().split('+').filter(Boolean);
  const key = parts.pop();
  if (!key || !/^([a-z0-9]|f\d{1,2}|enter|space|escape|arrow(up|down|left|right)|[-=[\];',./`])$/.test(key)) return null;
  const mods = ['ctrl', 'alt', 'shift', 'meta'].filter((m) => parts.includes(m) || (m === 'meta' && parts.includes('cmd')));
  if (parts.some((p) => !['ctrl', 'alt', 'shift', 'meta', 'cmd'].includes(p))) return null;
  // A plain letter or digit is typing, not a key to bind; F keys need no modifier.
  if (!mods.length && !/^f\d/.test(key)) return null;
  return [...mods, key].join('+');
}

/** The key a keyboard event is, as `normalKey` writes them. */
export function keyOf(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const code = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? k;
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', code].filter(Boolean).join('+');
}

/** Saves what a definition says. */
export function define(a: Extract<Action, { kind: 'alias' | 'let' | 'bind' }>) {
  if (a.kind === 'alias') save(ALIASES, a.name, a.text);
  else if (a.kind === 'let') save(VARS, a.name, a.value);
  else save(BINDS, a.key, a.text);
}
