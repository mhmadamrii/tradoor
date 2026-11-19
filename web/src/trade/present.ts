/**
 * Whether this browser has a trading account to follow: read by panels that
 * trade only when one is connected (the DOM), without loading the order system
 * to find out. The client sets it as sessions come and go.
 */
import { createSignal } from 'solid-js';
import { readJson } from '../lib/prefs';

// How many accounts the client last counted in this browser.
const [tradeOn, setTradeOn] = createSignal(Number(readJson('tradeAccounts')) > 0);
export { setTradeOn, tradeOn };
