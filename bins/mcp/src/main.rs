//! `tradoor-mcp`: a Model Context Protocol server over stdio.
//!
//! It lets an AI read the candle history `tradoor-backfill` and
//! `tradoor-recorder` keep, and backtest Frost Script strategies over it with
//! the same tester the app has (`tradoor-frost-script`), fees, slippage and
//! stops included. It needs no database and no running server: only the data
//! directory.
//!
//! Messages are JSON-RPC 2.0, one to a line. Only protocol goes to stdout;
//! anything for a person goes to stderr.

mod backtest;
mod candles;

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{bail, Context};
use clap::Parser;
use serde_json::{json, Map, Value};
use tradoor_core::time::{iso_minute, parse_iso};
use tradoor_core::Interval;
use tradoor_ingest::{Config, Ingest};
use tradoor_store::{now_ms, DataDir};
use tradoor_venues::MarketRef;

#[derive(Parser)]
#[command(about = "MCP server: candle history and Frost Script backtests, over stdio")]
struct Args {
    /// Where the candle partitions are kept: the same as the server's.
    #[arg(long, env = "TRADOOR_DATA_DIR", default_value = "./data")]
    data_dir: PathBuf,
}

/// The Frost Script reference an AI writes strategies from.
const GUIDE: &str = include_str!("../../../web/public/frost-script-ai.txt");

/// A whole strategy, as a starting point: a trend filter, an oscillator, and a
/// Fibonacci retracement of the recent swing as the limit entry.
const EXAMPLE: &str = r#"input fast = 13 min 1 max 200 "Fast EMA"
input slow = 21 min 2 max 400 "Slow EMA"
input klen = 14 min 2 max 200 "Stochastic length"
input swing = 30 min 5 max 500 "Swing lookback"
input fibLevel = 0.618 min 0.1 max 0.9 step 0.001 "Fibonacci level"
fastMa = ema(close, fast)
slowMa = ema(close, slow)
k = sma(stoch(close, high, low, klen), 3)
hi = highest(swing)
lo = lowest(swing)
up = fastMa > slowMa
down = fastMa < slowMa
fibLong = hi - (hi - lo) * fibLevel
fibShort = lo + (hi - lo) * fibLevel
goLong = up and k < 40
goShort = down and k > 60
long(goLong, fibLong)
short(goShort, fibShort)
stop(inlong ? lo : (inshort ? hi : na))
target(inlong ? entryprice + (entryprice - lo) * 2 : (inshort ? entryprice - (hi - entryprice) * 2 : na))
plot(fastMa, "Fast EMA", aqua)
plot(slowMa, "Slow EMA", orange)
"#;

// ---------------------------------------------------------------- tools

fn tools() -> Value {
    let market = json!({"type": "string", "description": "venue:SYMBOL, e.g. binance-perp:BTCUSDT"});
    let interval = json!({"type": "string", "description": "1m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w 1M (case matters: 1m is a minute, 1M a month)"});
    let when = |what: &str| json!({"type": "string", "description": format!("{what}, UTC: YYYY-MM-DD or YYYY-MM-DDTHH:MM")});
    let number = |what: &str| json!({"type": "number", "description": what});
    json!([
        {
            "name": "frost_script_guide",
            "description": "Read this first. The Frost Script language reference (the language strategies are written in) and a complete example strategy: EMA 13/21 trend, stochastic, and a Fibonacci retracement limit entry with stop and target.",
            "inputSchema": {"type": "object", "properties": {}}
        },
        {
            "name": "list_markets",
            "description": "The markets whose candle history is stored here, and which bases (1m, 1h, 1d) and periods each holds. A market not listed needs download_history first.",
            "inputSchema": {"type": "object", "properties": {}}
        },
        {
            "name": "download_history",
            "description": "Download and store closed candles of a market from a day on, from the exchange. Safe to repeat: what is stored is skipped. Can take minutes for a long range of 1m bars.",
            "inputSchema": {"type": "object", "properties": {"market": market, "from": when("The first day to keep")}, "required": ["market", "from"]}
        },
        {
            "name": "get_candles",
            "description": "Stored candles as [time, open, high, low, close, volume] rows, oldest first. With `from` the first `limit` bars after it, else the newest `limit`.",
            "inputSchema": {"type": "object", "properties": {"market": market, "interval": interval, "from": when("Start"), "to": when("End, exclusive"), "limit": number("Rows, 1 to 1000; default 100")}, "required": ["market", "interval"]}
        },
        {
            "name": "check_script",
            "description": "Check a Frost Script without running it: its error (line and column), its settings (inputs) and whether it is a strategy (gives long/short orders).",
            "inputSchema": {"type": "object", "properties": {"script": {"type": "string"}}, "required": ["script"]}
        },
        {
            "name": "backtest",
            "description": "Backtest a Frost Script strategy over stored history with the app's own tester: orders fill at the next bar's open (limits where reached), with fees, slippage, stops, targets and liquidation; a bar that reaches both stop and target is decided by lower-timeframe bars. Returns statistics, the trades and warnings. To test 'N trades', set max_trades: the first N are kept and counted. Percent arguments are in percent (2 is 2%).",
            "inputSchema": {"type": "object", "properties": {
                "script": {"type": "string", "description": "Frost Script that gives long(...) or short(...) orders. See frost_script_guide."},
                "market": market,
                "interval": interval,
                "from": when("Start of trading: positions open from here. Bars before it warm the indicators up"),
                "to": when("End of trading: nothing opens from here, and an open position closes"),
                "warmup_bars": number("Bars read before `from` so indicators have values; default 500"),
                "inputs": {"type": "array", "items": {"type": "number"}, "description": "Values for the script's `input` settings, in the order it declares them; missing ones take their default"},
                "max_trades": number("Keep and count only the first N trades"),
                "list_trades": number("How many trades to list in the answer; default 50"),
                "capital": number("Starting equity in the quote currency; default 10000"),
                "size_equity_pct": number("Margin per position as a share of equity, in percent; default 100"),
                "size_fixed": number("Margin per position as a fixed amount of the quote currency"),
                "size_risk_pct": number("Size each position to lose this percent of equity at its first stop (needs a stop)"),
                "leverage": number("At least 1; default 1"),
                "taker_fee_pct": number("Fee on market and stop fills, percent; default 0.05"),
                "maker_fee_pct": number("Fee on limit fills and targets, percent; default 0.02"),
                "slippage_pct": number("Lost against each market and stop fill, percent; default 0"),
                "on_close": {"type": "boolean", "description": "Fill at the close of the bar the order was given on, not the next open"},
                "longs": {"type": "boolean", "description": "Allow longs; default true"},
                "shorts": {"type": "boolean", "description": "Allow shorts; default true"},
                "stop_pct": number("A stop this far from the entry, percent"),
                "stop_atr": number("A stop this many ATRs from the entry"),
                "target_pct": number("A target this far from the entry, percent"),
                "target_atr": number("A target this many ATRs from the entry"),
                "target_r": number("A target this many times the stop's distance (needs a stop)"),
                "trail_pct": number("A trailing stop this far behind the best price, percent"),
                "trail_atr": number("A trailing stop this many ATRs behind the best price"),
                "atr_length": number("ATR length for the _atr settings; default 14"),
                "max_bars_in_trade": number("Close a position after this many bars; 0 for no limit"),
                "maintenance_margin_pct": number("Maintenance margin rate a liquidation is reckoned at, percent; 0 for none")
            }, "required": ["script", "market", "interval"]}
        }
    ])
}

// ---------------------------------------------------------------- arguments

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> anyhow::Result<&'a str> {
    args.get(key).and_then(Value::as_str).with_context(|| format!("{key} is required, a text"))
}

fn market(args: &Map<String, Value>) -> anyhow::Result<MarketRef> {
    let m = text(args, "market")?;
    MarketRef::parse(m).with_context(|| format!("not a market: {m} (expected venue:SYMBOL, e.g. binance-perp:BTCUSDT)"))
}

fn interval(args: &Map<String, Value>) -> anyhow::Result<Interval> {
    let i = text(args, "interval")?;
    Interval::parse(i).with_context(|| format!("not an interval: {i} (1m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w 1M)"))
}

fn moment(args: &Map<String, Value>, key: &str) -> anyhow::Result<Option<i64>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let s = v.as_str().with_context(|| format!("{key} is a text, YYYY-MM-DD"))?;
            parse_iso(s).map(Some).with_context(|| format!("{key}: {s} is not YYYY-MM-DD or YYYY-MM-DDTHH:MM (UTC)"))
        }
    }
}

fn count(args: &Map<String, Value>, key: &str) -> anyhow::Result<Option<usize>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(|n| Some(n as usize)).with_context(|| format!("{key} is a whole number, 0 or more")),
    }
}

// ---------------------------------------------------------------- calls

struct Server {
    data: DataDir,
}

impl Server {
    fn call(&self, name: &str, args: &Map<String, Value>) -> anyhow::Result<String> {
        match name {
            "frost_script_guide" => Ok(format!("EXAMPLE STRATEGY (EMA 13/21 trend + stochastic + Fibonacci limit entry). Pass it to backtest as `script`:\n\n{EXAMPLE}\nThe reference below is written for converting Pine Script; its language rules and STRATEGIES section apply to writing a strategy from scratch.\n\n{GUIDE}")),
            "list_markets" => self.list_markets(),
            "download_history" => self.download(args),
            "get_candles" => self.get_candles(args),
            "check_script" => check(text(args, "script")?),
            "backtest" => self.backtest(args),
            other => bail!("no such tool: {other}"),
        }
    }

    fn list_markets(&self) -> anyhow::Result<String> {
        let mut out = Vec::new();
        for m in self.data.markets()? {
            let mut bases = Map::new();
            for base in [Interval::M1, Interval::H1, Interval::D1] {
                let periods = self.data.periods(&m, base)?;
                if let (Some(a), Some(b)) = (periods.first(), periods.last()) {
                    bases.insert(base.as_str().to_string(), json!({"from": a.name(), "to": b.name(), "files": periods.len()}));
                }
            }
            out.push(json!({"market": m.to_string(), "bases": bases}));
        }
        Ok(serde_json::to_string_pretty(&json!({"data_dir": self.data.root().display().to_string(), "markets": out}))?)
    }

    fn download(&self, args: &Map<String, Value>) -> anyhow::Result<String> {
        let m = market(args)?;
        let from = moment(args, "from")?.context("from is required")?;
        let ingest = Ingest::new(self.data.clone(), Config::default())?;
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
        eprintln!("downloading {m} from {}", iso_minute(from));
        let stats = runtime.block_on(ingest.sync_market(&m, from, now_ms(), None)).with_context(|| format!("downloading {m}"))?;
        Ok(serde_json::to_string_pretty(&json!({"market": m.to_string(), "stats": serde_json::to_value(stats)?}))?)
    }

    fn get_candles(&self, args: &Map<String, Value>) -> anyhow::Result<String> {
        let (m, iv) = (market(args)?, interval(args)?);
        let (from, to) = (moment(args, "from")?, moment(args, "to")?);
        let limit = count(args, "limit")?.unwrap_or(100).clamp(1, 1000);
        let loaded = candles::load(&self.data, &m, iv, from, to)?;
        let all = loaded.bars.to_candles();
        let rows: &[_] = if from.is_some() { &all[..limit.min(all.len())] } else { &all[all.len().saturating_sub(limit)..] };
        let rows: Vec<Value> = rows.iter().map(|c| json!([iso_minute(c.open_time), c.open, c.high, c.low, c.close, c.volume])).collect();
        Ok(serde_json::to_string(&json!({"market": m.to_string(), "interval": iv.as_str(), "columns": ["time", "open", "high", "low", "close", "volume"], "rows": rows, "warnings": loaded.warnings}))?)
    }

    fn backtest(&self, args: &Map<String, Value>) -> anyhow::Result<String> {
        let (m, iv) = (market(args)?, interval(args)?);
        let script = text(args, "script")?;
        let (from, to) = (moment(args, "from")?, moment(args, "to")?);
        let warm = i64::try_from(count(args, "warmup_bars")?.unwrap_or(500)).unwrap_or(500);
        // Bars before `from` warm the indicators; nothing is opened in them.
        let read_from = from.map(|f| f - warm * iv.ms().unwrap_or(31 * 86_400_000));
        let inputs = match args.get("inputs") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.iter().map(|v| v.as_f64().filter(|x| x.is_finite()).context("inputs are numbers")).collect::<Result<_, _>>()?,
            Some(_) => bail!("inputs is a list of numbers"),
        };
        let settings = backtest::settings(args, from, to)?;
        let loaded = candles::load(&self.data, &m, iv, read_from, to)?;
        let req = backtest::Request { script, inputs, interval: iv, settings, max_trades: count(args, "max_trades")?, list_trades: count(args, "list_trades")?.unwrap_or(50) };
        let mut report = backtest::run(&req, &loaded)?;
        report["market"] = json!(m.to_string());
        Ok(serde_json::to_string_pretty(&report)?)
    }
}

fn check(script: &str) -> anyhow::Result<String> {
    Ok(match tradoor_frost_script::describe(script) {
        Ok(d) => serde_json::to_string_pretty(&json!({
            "ok": true,
            "strategy": d.strategy,
            "inputs": d.inputs.iter().map(|i| json!({"name": i.name, "label": i.label, "default": i.default, "min": i.min, "max": i.max})).collect::<Vec<_>>(),
            "plots": d.plots.iter().map(|p| p.0.clone()).collect::<Vec<_>>(),
        }))?,
        Err(e) => serde_json::to_string_pretty(&json!({"ok": false, "line": e.line, "column": e.col, "error": e.message}))?,
    })
}

// ---------------------------------------------------------------- protocol

fn reply(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn fault(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// The answer to one message, or none for a notification.
fn handle(server: &Server, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    Some(match method {
        "initialize" => {
            let version = msg.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18");
            reply(id, json!({
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "tradoor-mcp", "version": env!("CARGO_PKG_VERSION")},
                "instructions": "Candle history and Frost Script backtests. Call frost_script_guide first, then list_markets (download_history if a market is missing), write a strategy, check_script it, and backtest it."
            }))
        }
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({"tools": tools()})),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let empty = Map::new();
            let args = msg.pointer("/params/arguments").and_then(Value::as_object).unwrap_or(&empty);
            match server.call(name, args) {
                Ok(text) => reply(id, json!({"content": [{"type": "text", "text": text}]})),
                // A failed tool is a result the AI can read and act on, not a protocol error.
                Err(e) => reply(id, json!({"content": [{"type": "text", "text": format!("{e:#}")}], "isError": true})),
            }
        }
        _ => fault(id, -32601, "method not found"),
    })
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let server = Server { data: DataDir::new(&args.data_dir) };
    eprintln!("tradoor-mcp: data in {}", args.data_dir.display());
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let all: Vec<Value> = batch.iter().filter_map(|m| handle(&server, m)).collect();
                (!all.is_empty()).then(|| Value::Array(all))
            }
            Ok(msg) => handle(&server, &msg),
            Err(_) => Some(fault(&Value::Null, -32700, "parse error")),
        };
        if let Some(a) = answer {
            writeln!(stdout, "{a}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_example_strategy_is_a_strategy() {
        let d = tradoor_frost_script::describe(EXAMPLE).expect("the example compiles");
        assert!(d.strategy);
        assert_eq!(d.inputs.len(), 5);
    }

    #[test]
    fn the_example_runs_over_bars() {
        use tradoor_frost_script::{backtest, Bars, Funding, Inner, Settings};
        // A wave with a drift: enough turns for the trend filter, the oscillator and the swing to speak.
        let n = 3_000;
        let close: Vec<f64> = (0..n).map(|i| 100.0 + i as f64 * 0.01 + 8.0 * (i as f64 / 40.0).sin() + 3.0 * (i as f64 / 9.0).sin()).collect();
        let open: Vec<f64> = std::iter::once(close[0]).chain(close.iter().copied()).take(n).collect();
        let high: Vec<f64> = close.iter().zip(&open).map(|(c, o)| c.max(*o) + 0.4).collect();
        let low: Vec<f64> = close.iter().zip(&open).map(|(c, o)| c.min(*o) - 0.4).collect();
        let time: Vec<f64> = (0..n).map(|i| i as f64 * 3_600_000.0).collect();
        let volume = vec![1.0; n];
        let bars = Bars { time: &time, open: &open, high: &high, low: &low, close: &close, volume: &volume };
        let (_, report) = backtest(EXAMPLE, &[], &bars, 2, Settings::default(), Inner::default(), Funding::default()).expect("the example backtests");
        assert!(report.trades.len() >= 10, "only {} trades", report.trades.len());
        assert_eq!(report.equity.len(), n);
    }

    #[test]
    fn a_failed_tool_is_a_readable_result() {
        let server = Server { data: DataDir::new("./no-such-dir") };
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_candles", "arguments": {"market": "binance-perp:BTCUSDT", "interval": "1h"}}});
        let out = handle(&server, &msg).expect("answered");
        assert_eq!(out["result"]["isError"], json!(true));
        assert!(out["result"]["content"][0]["text"].as_str().unwrap().contains("download_history"));
    }

    #[test]
    fn a_notification_is_not_answered() {
        let server = Server { data: DataDir::new("./x") };
        assert!(handle(&server, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
    }
}
