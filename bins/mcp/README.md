# tradoor-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It lets an AI read the candle history stored on this machine and backtest Frost Script strategies over it, with the same tester the app uses (`crates/frost-script`): fees, slippage, stops, targets, trailing stops and liquidation included.

It needs no database and no running `tradoor-server`. It reads the data directory (`TRADOOR_DATA_DIR`, default `./data`) and downloads missing history from the exchanges itself.

It does not drive the chart in the window yet: drawings, replay and the view are not reachable from here.

## Tools

| Tool | What it does |
|---|---|
| `frost_script_guide` | The Frost Script reference, and a full example strategy: EMA 13/21 trend, stochastic, and a Fibonacci retracement limit entry with stop and target. An AI reads this first. |
| `list_markets` | The markets stored here, and which bases (1m, 1h, 1d) and periods each has. |
| `download_history` | Downloads and stores closed candles of a market from a day on. Safe to repeat. |
| `get_candles` | Stored candles at any interval, as rows. |
| `check_script` | Compiles a script without running it: its error (line and column), its settings, whether it is a strategy. |
| `backtest` | Runs a strategy over a market, interval and date range, and returns statistics, the trades and warnings. |

Markets are written `venue:SYMBOL`, for example `binance-perp:BTCUSDT`. Intervals are `1m 5m 15m 30m 1h 2h 4h 6h 12h 1d 1w 1M`; case matters.

## Build and register

```sh
cargo build --release -p tradoor-mcp        # target/release/tradoor-mcp(.exe)
```

Claude Code:

```sh
claude mcp add tradoor -e TRADOOR_DATA_DIR=C:/Users/you/dev/tradoor/data -- C:/Users/you/dev/tradoor/target/release/tradoor-mcp.exe
```

Any other MCP client: run the binary as a stdio server, with `TRADOOR_DATA_DIR` set (or `--data-dir`). Use an absolute path, because a client starts the server from its own working directory.

## Backtests

An example request, in words: "use EMA 13 and 21 and stochastic, use Fibonacci to seek the entry price, do 10 trades" becomes a `backtest` call with the example strategy as `script`, `max_trades: 10`, and a market, interval and range.

- Orders are given at a bar's close and fill at the next bar's open. A limit order (`long(condition, price)`) fills where the next bar reaches the price, which is how the Fibonacci entry works.
- `from` is where trading starts. Bars before it (`warmup_bars`, default 500) only warm the indicators up. `to` is where nothing more opens and an open position closes.
- `max_trades: N` keeps and counts the first N trades. A trade's result never depends on later ones, so these are the trades a run stopped at N would have made. The answer warns when the script made fewer.
- A bar that reaches both a stop and a target is decided by the next finer stored bars (1m under 1h, 1h under 1d, the base under a rolled-up interval). Where none are stored, the stop is taken first and the answer says how many bars were decided that way.
- Percent settings are in percent: `stop_pct: 2` is 2%. Settings are optional; the defaults are 10,000 capital, the whole equity per position, 1x leverage, 0.05% taker and 0.02% maker fees, no slippage.
- At most 100,000 bars are tested; past that the newest are kept, and the answer says so.

Drawdown and the profit factor are worked out from the closed trades in turn, not bar by bar.

## Limits

- Perpetual funding is not stored, so none is charged. The answer says so.
- Only candles from the data directory are used. Live bars are not.
- `download_history` blocks the server while it runs, and a long range of 1m bars can take minutes: an MCP client may time out and ask again, which is safe.
