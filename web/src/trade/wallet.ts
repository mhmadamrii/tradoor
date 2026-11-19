/**
 * The owner's own wallet (MetaMask, Rabby, any EIP-1193 browser wallet): asked
 * for the account's address and, once, to sign the approval of a trading key.
 * It never signs an order; the trading key does that.
 */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface Announced {
  info: { name: string; rdns: string; icon: string; uuid: string };
  provider: Eip1193;
}

/** A wallet as the picker shows it: its name and icon, as it announced them. */
export interface WalletChoice {
  id: string;
  name: string;
  /** A data: image, or empty; anything else a wallet sends is not shown. */
  icon: string;
}

/** The wallets this browser has, as they announce themselves (EIP-6963), or the one at `window.ethereum`. */
export async function wallets(): Promise<Announced[]> {
  const found: Announced[] = [];
  const on = (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.provider && !found.some((f) => f.info.uuid === d.info.uuid)) found.push(d);
  };
  window.addEventListener('eip6963:announceProvider', on);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 150));
  window.removeEventListener('eip6963:announceProvider', on);
  const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!found.length && legacy) found.push({ info: { name: 'Browser wallet', rdns: '', icon: '', uuid: 'legacy' }, provider: legacy });
  return found;
}

/** Marks for wallets that announce none the page can show, by their reverse-DNS name. */
const OWN_ICONS: Record<string, string> = {
  'app.phantom': `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#AB9FF2"/><path fill="#FFF" d="M7 18.6C7 12.2 11 7.5 16.6 7.5c5.3 0 8.4 4.1 8.4 9.4 0 4.2-2.4 7.6-4.8 7.6-1.3 0-1.9-1-2.4-1.9-.6 1-1.4 1.9-2.6 1.9-1.4 0-2.1-1-2.5-1.9-.6 1.1-1.6 1.9-2.8 1.9C8.4 24.5 7 22.3 7 18.6z"/><ellipse cx="15.5" cy="15.5" rx="1.3" ry="2" fill="#AB9FF2"/><ellipse cx="20" cy="15.5" rx="1.3" ry="2" fill="#AB9FF2"/></svg>')}`,
};

/** MetaMask first, then the rest as they announced themselves. */
const firstOf = (rdns: string) => (rdns === 'io.metamask' ? 0 : 1);

/** The wallets to pick from, as the page may show them: an image icon of any kind (an <img> runs none of it), else tradoor's own. */
export async function walletChoices(): Promise<WalletChoice[]> {
  return (await wallets())
    .slice()
    .sort((x, y) => firstOf(x.info.rdns) - firstOf(y.info.rdns))
    .map((w) => ({ id: w.info.uuid, name: w.info.name || 'Browser wallet', icon: /^data:image\//.test(w.info.icon ?? '') ? w.info.icon : (OWN_ICONS[w.info.rdns] ?? '') }));
}

/** One wallet by its id; the first when none is named. */
export async function walletById(id?: string): Promise<Announced | undefined> {
  const list = (await wallets()).slice().sort((x, y) => firstOf(x.info.rdns) - firstOf(y.info.rdns));
  return (id ? list.find((w) => w.info.uuid === id) : undefined) ?? list[0];
}

/** The address the wallet trades as, and the chain it is on (its signature must name that chain). */
export async function walletAccount(w: Eip1193): Promise<{ owner: string; chain: number }> {
  const accounts = (await w.request({ method: 'eth_requestAccounts' })) as string[];
  const owner = accounts[0];
  if (!owner) throw new Error('The wallet gave no account');
  const chain = parseInt(String(await w.request({ method: 'eth_chainId' })), 16);
  return { owner: owner.toLowerCase(), chain };
}

export async function signTyped(w: Eip1193, owner: string, typed: unknown): Promise<string> {
  return String(await w.request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(typed)] }));
}

/** A plain message signed by the wallet (EIP-191): what Lighter has an API key registered with. */
export async function personalSign(w: Eip1193, owner: string, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return String(await w.request({ method: 'personal_sign', params: [hex, owner] }));
}

/** A wallet's refusal in words: the person said no, or something else. */
export function walletError(e: unknown): string {
  const code = (e as { code?: number })?.code;
  if (code === 4001) return 'Declined in the wallet';
  return e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
}
