//! A strategy run over stored history, and what it made.

use anyhow::{bail, Context};
use serde_json::{json, Map, Value};
use tradoor_core::time::iso_minute;
use tradoor_core::Interval;
use tradoor_frost_script::{backtest, Bars, Exit, Funding, Inner, Reason, Settings, Size, Trade, MAX_BARS};

use crate::candles::Loaded;

fn num(args: &Map<String, Value>, key: &str) -> anyhow::Result<Option<f64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_f64().filter(|x| x.is_finite()).map(Some).with_context(|| format!("{key} is a number")),
    }
}

fn flag(args: &Map<String, Value>, key: &str) -> anyhow::Result<Option<bool>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_bool().map(Some).with_context(|| format!("{key} is true or false")),
    }
}

/// A distance asked for as `<name>_pct` (in percent), `<name>_atr` or `<name>_r`: at most one.
fn exit(args: &Map<String, Value>, name: &str, allow_r: bool) -> anyhow::Result<Exit> {
    let pct = num(args, &format!("{name}_pct"))?;
    let atr = num(args, &format!("{name}_atr"))?;
    let r = if allow_r { num(args, &format!("{name}_r"))? } else { None };
    match (pct, atr, r) {
        (None, None, None) => Ok(Exit::None),
        (Some(p), None, None) if p > 0.0 => Ok(Exit::Pct(p / 100.0)),
        (None, Some(k), None) if k > 0.0 => Ok(Exit::Atr(k)),
        (None, None, Some(k)) if k > 0.0 => Ok(Exit::R(k)),
        _ => bail!("give one of {name}_pct, {name}_atr{} as a positive number", if allow_r { ", target_r" } else { "" }),
    }
}

/// The tester's settings from the tool's arguments; every one is optional.
pub fn settings(args: &Map<String, Value>, from: Option<i64>, to: Option<i64>) -> anyhow::Result<Settings> {
    let mut s = Settings::default();
    if let Some(v) = num(args, "capital")? {
        s.capital = v;
    }
    let sizes = [num(args, "size_equity_pct")?, num(args, "size_fixed")?, num(args, "size_risk_pct")?];
    if sizes.iter().flatten().count() > 1 {
        bail!("give one of size_equity_pct, size_fixed, size_risk_pct");
    }
    s.size = match sizes {
        [Some(p), ..] => Size::Equity(p / 100.0),
        [_, Some(m), _] => Size::Fixed(m),
        [_, _, Some(r)] => Size::Risk(r / 100.0),
        _ => s.size,
    };
    if let Some(v) = num(args, "leverage")? {
        s.leverage = v;
    }
    // Fees and slippage are given in percent, as the app's own form has them.
    if let Some(v) = num(args, "taker_fee_pct")? {
        s.taker = v / 100.0;
    }
    if let Some(v) = num(args, "maker_fee_pct")? {
        s.maker = v / 100.0;
    }
    if let Some(v) = num(args, "slippage_pct")? {
        s.slippage = v / 100.0;
    }
    if let Some(v) = flag(args, "on_close")? {
        s.on_close = v;
    }
    if let Some(v) = flag(args, "longs")? {
        s.longs = v;
    }
    if let Some(v) = flag(args, "shorts")? {
        s.shorts = v;
    }
    s.stop = exit(args, "stop", false)?;
    s.target = exit(args, "target", true)?;
    s.trail = exit(args, "trail", false)?;
    if let Some(v) = num(args, "atr_length")? {
        s.atr_length = v.max(1.0) as usize;
    }
    if let Some(v) = num(args, "max_bars_in_trade")? {
        s.max_bars = v.max(0.0) as usize;
    }
    if let Some(v) = num(args, "maintenance_margin_pct")? {
        s.mmr = v / 100.0;
    }
    s.from = from.map_or(f64::NAN, |t| t as f64);
    s.to = to.map_or(f64::NAN, |t| t as f64);
    Ok(s)
}

struct Columns {
    time: Vec<f64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    volume: Vec<f64>,
}

fn columns(t: &tradoor_codec::TickCandles) -> Columns {
    let c = t.to_candles();
    Columns {
        time: c.iter().map(|x| x.open_time as f64).collect(),
        open: c.iter().map(|x| x.open).collect(),
        high: c.iter().map(|x| x.high).collect(),
        low: c.iter().map(|x| x.low).collect(),
        close: c.iter().map(|x| x.close).collect(),
        volume: c.iter().map(|x| x.volume).collect(),
    }
}

fn reason(r: Reason) -> &'static str {
    match r {
        Reason::Open => "still_open",
        Reason::Signal => "exit_signal",
        Reason::Stop => "stop",
        Reason::Target => "target",
        Reason::Trail => "trailing_stop",
        Reason::Time => "max_bars",
        Reason::Liquidation => "liquidation",
        Reason::Reverse => "reversed",
        Reason::End => "range_end",
    }
}

fn round(v: f64, digits: i32) -> Value {
    if !v.is_finite() {
        return Value::Null;
    }
    let k = 10f64.powi(digits);
    json!((v * k).round() / k)
}

fn trade_json(t: &Trade, n: usize) -> Value {
    json!({
        "n": n,
        "side": if t.long { "long" } else { "short" },
        "entry_time": iso_minute(t.entry_time as i64),
        "entry_price": t.entry_price,
        "exit_time": iso_minute(t.exit_time as i64),
        "exit_price": t.exit_price,
        "exit_reason": reason(t.reason),
        "bars_held": t.exit_bar.saturating_sub(t.entry_bar),
        "qty": round(t.qty, 8),
        "pnl": round(t.pnl, 2),
        "return_pct": round(t.pnl / t.equity_before * 100.0, 2),
        "fees": round(t.fees, 2),
        "funding": round(t.funding, 2),
        "max_adverse_pct": round(t.mae * 100.0, 2),
        "max_favourable_pct": round(t.mfe * 100.0, 2),
    })
}

/// What the first `trades` made, reckoned trade by trade: the equity is the
/// capital with each closed trade's result added in turn.
fn stats(trades: &[Trade], capital: f64) -> Value {
    let n = trades.len();
    let wins: Vec<f64> = trades.iter().map(|t| t.pnl).filter(|p| *p > 0.0).collect();
    let losses: Vec<f64> = trades.iter().map(|t| t.pnl).filter(|p| *p < 0.0).collect();
    let gross_win: f64 = wins.iter().sum();
    let gross_loss: f64 = losses.iter().map(|p| -p).sum();
    let net: f64 = trades.iter().map(|t| t.pnl).sum();
    let (mut equity, mut peak, mut worst) = (capital, capital, 0.0f64);
    for t in trades {
        equity += t.pnl;
        peak = peak.max(equity);
        worst = worst.max((peak - equity) / peak);
    }
    let mean = |v: &[f64]| if v.is_empty() { f64::NAN } else { v.iter().sum::<f64>() / v.len() as f64 };
    json!({
        "trades": n,
        "longs": trades.iter().filter(|t| t.long).count(),
        "shorts": trades.iter().filter(|t| !t.long).count(),
        "wins": wins.len(),
        "losses": losses.len(),
        "win_rate_pct": if n == 0 { Value::Null } else { round(wins.len() as f64 / n as f64 * 100.0, 1) },
        "net_pnl": round(net, 2),
        "return_pct": round(net / capital * 100.0, 2),
        "end_equity": round(capital + net, 2),
        "profit_factor": if gross_loss == 0.0 { Value::Null } else { round(gross_win / gross_loss, 2) },
        "avg_win": round(mean(&wins), 2),
        "avg_loss": round(mean(&losses), 2),
        "expectancy_per_trade": if n == 0 { Value::Null } else { round(net / n as f64, 2) },
        "max_drawdown_pct": round(worst * 100.0, 2),
        "fees_paid": round(trades.iter().map(|t| t.fees).sum::<f64>(), 2),
        "funding_paid": round(trades.iter().map(|t| t.funding).sum::<f64>(), 2),
        "liquidations": trades.iter().filter(|t| t.reason == Reason::Liquidation).count(),
    })
}

pub struct Request<'a> {
    pub script: &'a str,
    pub inputs: Vec<f64>,
    pub interval: Interval,
    pub settings: Settings,
    /// Only the first this many trades are kept, and counted.
    pub max_trades: Option<usize>,
    pub list_trades: usize,
}

pub fn run(req: &Request, loaded: &Loaded) -> anyhow::Result<Value> {
    let mut warnings = loaded.warnings.clone();
    let mut bars = columns(&loaded.bars);
    if bars.time.len() > MAX_BARS {
        let cut = bars.time.len() - MAX_BARS;
        for v in [&mut bars.time, &mut bars.open, &mut bars.high, &mut bars.low, &mut bars.close, &mut bars.volume] {
            v.drain(..cut);
        }
        warnings.push(format!("the range holds more than {MAX_BARS} bars: only the newest {MAX_BARS} were tested"));
    }
    let inner = columns(&loaded.inner);
    let view = Bars { time: &bars.time, open: &bars.open, high: &bars.high, low: &bars.low, close: &bars.close, volume: &bars.volume };
    let lower = Inner { time: &inner.time, open: &inner.open, high: &inner.high, low: &inner.low, close: &inner.close };
    let (_, report) = backtest(req.script, &req.inputs, &view, loaded.bars.price_scale, req.settings, lower, Funding::default()).map_err(|e| anyhow::anyhow!("script: {e}"))?;

    let kept = req.max_trades.map_or(report.trades.len(), |m| m.min(report.trades.len()));
    // A trade's result never depends on the ones after it, so the first ones are the same as if the run had stopped there.
    let trades = &report.trades[..kept];
    if req.max_trades.is_some_and(|m| report.trades.len() < m) {
        warnings.push(format!("the script made only {} trades in this range, fewer than the {} asked for", report.trades.len(), req.max_trades.unwrap_or(0)));
    }
    if trades.iter().any(|t| t.reason == Reason::Open) {
        warnings.push("the last trade is still open at the end of the range: its result is at the last close".to_string());
    }
    if !report.ambiguous.is_empty() {
        warnings.push(format!("{} bars reached both a stop and a target with no lower bars to say which came first; each was counted as stopped", report.ambiguous.len()));
    }
    if report.skipped > 0 {
        warnings.push(format!("{} orders were not filled (risk sizing with no stop, or no equity left)", report.skipped));
    }
    warnings.push("perpetual funding is not stored, so none was charged".to_string());

    let first = bars.time.first().copied().unwrap_or(0.0) as i64;
    let last = bars.time.last().copied().unwrap_or(0.0) as i64;
    Ok(json!({
        "interval": req.interval.as_str(),
        "bars_tested": bars.time.len(),
        "range": { "from": iso_minute(first), "to": iso_minute(last) },
        "lower_timeframe_bars_used": inner.time.len(),
        "bars_decided_by_lower_timeframe": report.magnified,
        "stats": stats(trades, req.settings.capital),
        "trades": trades.iter().take(req.list_trades).enumerate().map(|(i, t)| trade_json(t, i + 1)).collect::<Vec<_>>(),
        "trades_listed": trades.len().min(req.list_trades),
        "warnings": warnings,
    }))
}
