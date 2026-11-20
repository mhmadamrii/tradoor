/**
 * A position as a picture to share: the coin, which way and how levered, its
 * return on margin in large figures, the money (or not), its entry and mark,
 * the exchange and the day — 1200 × 630, the size a post shows whole. Copied
 * to the clipboard or saved as a PNG, made in this browser.
 */
import { createEffect, createSignal, onMount } from 'solid-js';
import { toast } from '../lib/toasts';
import { price } from './format';
import { VENUE_NAME, type AccountRef, type Position } from './protocol';

const W = 1200;
const H = 630;

function css(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function draw(c: HTMLCanvasElement, p: Position, a: AccountRef, mark: number | null, showMoney: boolean, showPrices: boolean, logo: HTMLImageElement | null) {
  const ctx = c.getContext('2d')!;
  const font = getComputedStyle(document.body).fontFamily || 'monospace';
  const bull = css('--bull', '#aafd35');
  const bear = css('--bear', '#ff4d5f');
  const text = css('--text', '#e6e8e6');
  const muted = css('--muted', '#8a908a');
  const long = p.size > 0;
  const gain = p.pnl >= 0;
  const tone = gain ? bull : bear;
  // The ground: dark, a faint grid, a glow of the result's colour.
  ctx.fillStyle = '#070907';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) (ctx.beginPath(), ctx.moveTo(x + 0.5, 0), ctx.lineTo(x + 0.5, H), ctx.stroke());
  for (let y = 0; y <= H; y += 40) (ctx.beginPath(), ctx.moveTo(0, y + 0.5), ctx.lineTo(W, y + 0.5), ctx.stroke());
  const glow = ctx.createRadialGradient(W * 0.78, H * 0.45, 20, W * 0.78, H * 0.45, 520);
  glow.addColorStop(0, `${tone}33`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = `${tone}88`;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  // The mark and the name.
  ctx.textBaseline = 'alphabetic';
  if (logo) ctx.drawImage(logo, 64, 56, 56, 56);
  ctx.fillStyle = bull;
  ctx.font = `700 34px ${font}`;
  ctx.fillText('tradoor', logo ? 134 : 64, 96);
  ctx.fillStyle = muted;
  ctx.font = `400 20px ${font}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${VENUE_NAME[a.venue]}${a.network === 'testnet' ? ' testnet' : ''}`, W - 64, 92);
  ctx.textAlign = 'left';
  // The coin, the side, the leverage.
  ctx.fillStyle = text;
  ctx.font = `700 64px ${font}`;
  ctx.fillText(`${p.coin}-PERP`, 64, 230);
  const side = long ? 'LONG' : 'SHORT';
  ctx.font = `700 26px ${font}`;
  const sw = ctx.measureText(side).width + 36;
  ctx.font = `700 64px ${font}`;
  const x0 = 64 + ctx.measureText(`${p.coin}-PERP`).width + 28;
  ctx.fillStyle = long ? bull : bear;
  ctx.fillRect(x0, 186, sw, 48);
  ctx.fillStyle = '#070907';
  ctx.font = `700 26px ${font}`;
  ctx.fillText(side, x0 + 18, 220);
  ctx.fillStyle = muted;
  ctx.fillText(`${p.leverage}×`, x0 + sw + 18, 220);
  // The result, large.
  ctx.fillStyle = tone;
  ctx.font = `700 132px ${font}`;
  const roe = `${gain ? '+' : '−'}${Math.abs(p.roe * 100).toFixed(2)}%`;
  ctx.fillText(roe, 60, 390);
  if (showMoney) {
    ctx.font = `600 36px ${font}`;
    ctx.fillText(`${gain ? '+' : '−'}$${Math.abs(p.pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 64, 450);
  }
  // Entry and mark.
  if (showPrices) {
    ctx.font = `400 22px ${font}`;
    ctx.fillStyle = muted;
    ctx.fillText('Entry', 64, 528);
    ctx.fillText('Mark', 344, 528);
    ctx.fillStyle = text;
    ctx.font = `600 30px ${font}`;
    ctx.fillText(price(p.entry), 64, 566);
    ctx.fillText(price(mark), 344, 566);
  }
  ctx.textAlign = 'right';
  ctx.font = `400 20px ${font}`;
  ctx.fillStyle = muted;
  ctx.fillText(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), W - 64, 566);
  ctx.fillText('tradoorterminal.com', W - 64, 536);
  ctx.textAlign = 'left';
}

export function PnlCard(props: { account: AccountRef; position: Position; mark: number | null; onClose: () => void }) {
  let canvas!: HTMLCanvasElement;
  const [money, setMoney] = createSignal(true);
  const [prices, setPrices] = createSignal(true);
  const [logo, setLogo] = createSignal<HTMLImageElement | null>(null);
  onMount(() => {
    const img = new Image();
    img.onload = () => setLogo(img);
    img.src = '/logo.svg';
  });
  createEffect(() => draw(canvas, props.position, props.account, props.mark, money(), prices(), logo()));
  const blob = () => new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  const copy = async () => {
    try {
      const b = await blob();
      if (!b) throw new Error('No picture');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
      toast({ tone: 'info', title: 'Copied', body: 'The picture is on the clipboard' }, 4000);
    } catch {
      toast({ tone: 'warn', title: 'Not copied', body: 'This browser would not copy a picture: save it instead' });
    }
  };
  const save = async () => {
    const b = await blob();
    if (!b) return;
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tradoor ${props.position.coin} ${props.position.size > 0 ? 'long' : 'short'}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <div class="backdrop" onPointerDown={() => props.onClose()}>
      <div class="dialog om-card" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && props.onClose()} tabIndex={-1}>
        <header>
          <span class="title caps">Share the position</span>
          <span class="spacer" />
          <span class="dim">Your address is never on it</span>
          <button class="x" onClick={() => props.onClose()}>
            esc ✕
          </button>
        </header>
        <canvas ref={canvas} width={W} height={H} />
        <footer>
          <span class="om-card-opts">
            <label class="om-check">
              <input type="checkbox" checked={money()} onChange={(e) => setMoney(e.currentTarget.checked)} /> The money
            </label>
            <label class="om-check">
              <input type="checkbox" checked={prices()} onChange={(e) => setPrices(e.currentTarget.checked)} /> Entry and mark
            </label>
          </span>
          <span class="om-card-acts">
            <button class="dbtn" onClick={() => void copy()}>
              Copy
            </button>
            <button class="dbtn" onClick={() => void save()}>
              Save PNG
            </button>
          </span>
        </footer>
      </div>
    </div>
  );
}
