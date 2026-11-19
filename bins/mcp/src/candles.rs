//! Candles read from the data directory, at any interval the app has.
//!
//! History is kept at three bases (1m, 1h, 1d); every other interval is rolled
//! up from the nearest base below it, as the chart does.

use anyhow::{bail, Context};
use tradoor_codec::TickCandles;
use tradoor_core::Interval;
use tradoor_store::DataDir;
use tradoor_venues::MarketRef;

/// The base an interval is folded from.
pub fn base_of(interval: Interval) -> Interval {
    match interval {
        Interval::M1 | Interval::M5 | Interval::M15 | Interval::M30 => Interval::M1,
        Interval::H1 | Interval::H2 | Interval::H4 | Interval::H6 | Interval::H12 => Interval::H1,
        Interval::D1 | Interval::W1 | Interval::Mo1 => Interval::D1,
    }
}

/// What `load` gives back.
pub struct Loaded {
    /// The chart's bars, oldest first.
    pub bars: TickCandles,
    /// Finer bars over the same time, for a bar's order of high and low: the base's
    /// where the interval is rolled up from it, else the next base down (1m under
    /// 1h, 1h under 1d). Empty where there are none.
    pub inner: TickCandles,
    pub warnings: Vec<String>,
}

/// The base one step finer than `base`, where a bar's own order of high and low is wanted.
fn finer(base: Interval) -> Option<Interval> {
    match base {
        Interval::H1 => Some(Interval::M1),
        Interval::D1 => Some(Interval::H1),
        _ => None,
    }
}

/// What is stored of `market` at `base`, within `from <= open_time < to`; none where nothing is.
fn read(data: &DataDir, market: &MarketRef, base: Interval, lo: i64, hi: i64) -> anyhow::Result<Option<TickCandles>> {
    let mut parts = Vec::new();
    for period in data.periods(market, base)? {
        if period.end() <= lo || period.start() >= hi {
            continue;
        }
        if let Some(t) = data.read(market, base, period)? {
            parts.push(t);
        }
    }
    Ok(TickCandles::merge(&parts).context("reading history")?.map(|m| m.slice(lo, hi)).filter(|m| !m.is_empty()))
}

/// Bars with `from <= open_time < to` (`None`: unbounded) of `market` at `interval`.
pub fn load(data: &DataDir, market: &MarketRef, interval: Interval, from: Option<i64>, to: Option<i64>) -> anyhow::Result<Loaded> {
    let base = base_of(interval);
    let (lo, hi) = (from.unwrap_or(i64::MIN), to.unwrap_or(i64::MAX));
    let Some(base_bars) = read(data, market, base, lo, hi)? else {
        bail!("{market} has no {} bars in that range: run download_history first, or ask for another range", base.as_str());
    };
    let mut warnings = Vec::new();
    if interval == base {
        // The chart's own bars say nothing of the order inside a bar: the next base down does, where it is stored.
        let inner = match finer(base) {
            Some(f) => match read(data, market, f, lo, hi)? {
                Some(t) => t,
                None => {
                    warnings.push(format!("no {} bars are stored for {market}, so a bar that reaches both a stop and a target is counted as stopped", f.as_str()));
                    TickCandles::empty(f)
                }
            },
            None => TickCandles::empty(base),
        };
        return Ok(Loaded { bars: base_bars, inner, warnings });
    }
    let mut rolled = base_bars.aggregate(interval);
    // The last bucket is complete only where the next base bar would open a new one.
    if let (Some(&last), Some(step)) = (base_bars.open_time.last(), base.ms()) {
        let complete = interval.align(last + step) != interval.align(last);
        if !complete && rolled.len() > 1 {
            rolled = rolled.slice(i64::MIN, *rolled.open_time.last().expect("non-empty"));
            warnings.push("the newest, unfinished bar was left out".to_string());
        }
    }
    Ok(Loaded { bars: rolled, inner: base_bars, warnings })
}
