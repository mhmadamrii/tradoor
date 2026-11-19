/// <reference lib="deno.ns" />
// hyperliquid-python-sdk's own signing tests (tests/signing_test.py), run through
// tradoor's MessagePack, wire format and the signer module as the browser loads it.
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { actions, approveAgent, Nonces, orderWire, roundPrice, roundSize, signAction, splitSignature, toWire, type Asset } from './hyperliquid.ts';
import { pack } from './msgpack.ts';
import { fromHex, loadSigner, toHex } from './signer.ts';

const signer = await loadSigner(await Deno.readFile(new URL('../wasm/trade/trade.wasm', import.meta.url)));
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const key = () => fromHex(KEY);
const asset = (n: number, szDecimals = 4): Asset => ({ name: 'ETH', asset: n, szDecimals, maxLeverage: 25, onlyIsolated: false });

Deno.test('an action is signed as the SDK signs it, on mainnet and testnet', () => {
  const dummy = { type: 'dummy', num: 100_000_000_000 };
  const main = signAction(signer, key(), dummy, 0, 'mainnet');
  assertEquals(main.signature, { r: '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', s: '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', v: 27 });
  const test = signAction(signer, key(), dummy, 0, 'testnet');
  assertEquals(test.signature, { r: '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', s: '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', v: 28 });
  const vault = signAction(signer, key(), dummy, 0, 'mainnet', '0x1719884eb866cb12b2287399b15f7db5e7d775ea');
  assertEquals(vault.signature, { r: '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', s: '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', v: 28 });
});

Deno.test('orders: a limit, one with an id, and a stop', () => {
  const limit = actions.order([orderWire({ asset: asset(1), buy: true, price: 100, size: 100 })]);
  assertEquals(signAction(signer, key(), limit, 0, 'mainnet').signature, { r: '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', s: '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', v: 28 });
  const withId = actions.order([orderWire({ asset: asset(1), buy: true, price: 100, size: 100, cloid: '0x00000000000000000000000000000001' })]);
  assertEquals(signAction(signer, key(), withId, 0, 'testnet').signature, { r: '0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d', s: '0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988', v: 28 });
  const stop = actions.order([orderWire({ asset: asset(1), buy: true, price: 100, size: 100, trigger: { price: 103, market: true, tpsl: 'sl' } })]);
  assertEquals(signAction(signer, key(), stop, 0, 'mainnet').signature, { r: '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9', s: '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', v: 27 });
});

Deno.test('a real order hashes as the exchange hashed it', () => {
  const action = actions.order([orderWire({ asset: asset(4), buy: true, price: 1670.1, size: 0.0147, tif: 'Ioc' })]);
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, 1677777606040n);
  const packed = pack(action);
  const data = new Uint8Array(packed.length + 9);
  data.set(packed);
  data.set(nonce, packed.length);
  assertEquals(toHex(signer.keccak(data)), '0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
});

Deno.test('prices and sizes as the exchange takes them', () => {
  assertEquals(roundPrice(1670.123456, 4), 1670.1);
  assertEquals(roundPrice(0.000123456, 0), 0.000123);
  assertEquals(roundPrice(97_123.4, 5), 97123);
  assertEquals(roundPrice(123_456.7, 5), 123457);
  assertEquals(roundPrice(2.345678, 1), 2.3457);
  assertEquals(roundSize(0.01999, 3), 0.019);
  assertEquals(roundSize(1.2, 1), 1.2);
  assertEquals(toWire(100), '100');
  assertEquals(toWire(1670.1), '1670.1');
  assertEquals(toWire(0.0147), '0.0147');
  assertEquals(toWire(-0), '0');
});

Deno.test('MessagePack refuses a fraction, which would sign differently', () => {
  assertThrows(() => pack({ p: 1.5 }));
  assertEquals(Array.from(pack({ a: -1, b: -200, c: 300, d: 2 ** 40 })), [0x84, 0xa1, 0x61, 0xff, 0xa1, 0x62, 0xd1, 0xff, 0x38, 0xa1, 0x63, 0xcd, 0x01, 0x2c, 0xa1, 0x64, 0xcf, 0, 0, 1, 0, 0, 0, 0, 0]);
});

Deno.test('a key, its address, and a fresh nonce each time', () => {
  const k = fromHex('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  assertEquals(toHex(signer.address(k)!), 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  assertEquals(signer.address(new Uint8Array(32)), null);
  const n = new Nonces();
  const a = n.next();
  assert(n.next() > a);
});

Deno.test('the approval the wallet signs names the key, the network and the expiry', () => {
  const { typed, action } = approveAgent({ network: 'testnet', walletChain: 42161, agent: '0xABCDEF0000000000000000000000000000000001', name: 'tradoor', validUntil: 1_800_000_000_000, nonce: 5 });
  assertEquals(typed.domain.chainId, 42161);
  assertEquals(typed.message, { hyperliquidChain: 'Testnet', agentAddress: '0xabcdef0000000000000000000000000000000001', agentName: 'tradoor valid_until 1800000000000', nonce: 5 });
  assertEquals(action.signatureChainId, '0xa4b1');
  const sig = splitSignature(`0x${'11'.repeat(32)}${'22'.repeat(32)}01`);
  assertEquals(sig.v, 28);
});
