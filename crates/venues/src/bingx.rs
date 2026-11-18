//! BingX spot and perpetuals. Both name a market `BTC-USDT`; here it is
//! `BTCUSDT`. Its REST answers no request a browser makes (a page's `Origin`
//! is refused), so a page reads it through the relay; its sockets take one.

use std::collections::HashMap;

use serde_json::Value;

use crate::catalog::{decimals_of, num, product, unique, Product};
use crate::{shape, Venue, VenueError};

pub const REST: &str = "https://open-api.bingx.com";
/// Quotes a market is listed under here.
const QUOTES: [&str; 2] = ["USDT", "USDC"];
/// Dollars a day below which a spot pair stays out of a search everyone downloads.
const SPOT_MIN_TURNOVER: f64 = 10_000.0;

pub fn contracts_url() -> String {
    format!("{REST}/openApi/swap/v2/quote/contracts")
}

pub fn perp_tickers_url() -> String {
    format!("{REST}/openApi/swap/v2/quote/ticker")
}

pub fn spot_symbols_url() -> String {
    format!("{REST}/openApi/spot/v1/common/symbols")
}

/// The spot table wants the time it is asked at.
pub fn spot_tickers_url() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{REST}/openApi/spot/v1/ticker/24hr?timestamp={now}")
}

/// Rows under `data` (or `data.symbols`), keyed by `symbol`.
fn rows(body: &str, what: &'static str) -> Result<Vec<Value>, VenueError> {
    let v: Value = serde_json::from_str(body)?;
    let data = &v["data"];
    let list = data.as_array().or_else(|| data["symbols"].as_array()).ok_or_else(|| shape(what))?;
    Ok(list.clone())
}

fn by_symbol(body: Option<&str>) -> Result<HashMap<String, Value>, VenueError> {
    let Some(body) = body else { return Ok(HashMap::new()) };
    Ok(rows(body, "bingx tickers")?.into_iter().filter_map(|r| Some((r["symbol"].as_str()?.to_string(), r))).collect())
}

/// `-1.62%` on spot, `-1.61` on the perpetuals.
fn percent(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::String(s) => s.trim_end_matches('%').parse().ok(),
        other => other.as_f64(),
    }
}

/// Online spot pairs in the dollar's stablecoins, with turnover enough to be worth
/// listing. Without the ticker table every one is kept.
pub fn parse_spot(symbols: &str, tickers: Option<&str>) -> Result<Vec<Product>, VenueError> {
    let stats = by_symbol(tickers)?;
    let list = rows(symbols, "bingx symbols")?
        .iter()
        .filter(|s| s["status"] == 1 && s["apiStateBuy"] == true && s["apiStateSell"] == true)
        .filter_map(|s| {
            let name = s["symbol"].as_str()?;
            let (base, quote) = name.rsplit_once('-')?;
            if !QUOTES.contains(&quote) {
                return None;
            }
            let t = stats.get(name);
            let turnover = t.and_then(|t| num(t.get("quoteVolume")));
            if !stats.is_empty() && turnover.unwrap_or(0.0) < SPOT_MIN_TURNOVER {
                return None;
            }
            product(Venue::BingxSpot, base, quote, name, s["tickSize"].as_f64().and_then(decimals_of), turnover, t.and_then(|t| num(t.get("lastPrice"))), t.and_then(|t| percent(t.get("priceChangePercent"))))
        })
        .collect();
    Ok(unique(list))
}

/// Perpetuals open to trading, in crypto: the `NC…` contracts (currencies,
/// metals, shares) stay out of a crypto search.
pub fn parse_perps(contracts: &str, tickers: Option<&str>) -> Result<Vec<Product>, VenueError> {
    let stats = by_symbol(tickers)?;
    let list = rows(contracts, "bingx contracts")?
        .iter()
        .filter(|c| c["status"] == 1 && c["apiStateOpen"] == "true")
        .filter_map(|c| {
            let name = c["symbol"].as_str()?;
            let (base, quote) = name.rsplit_once('-')?;
            if !QUOTES.contains(&quote) || base.starts_with("NC") && base.contains('2') {
                return None;
            }
            let t = stats.get(name);
            let decimals = c["pricePrecision"].as_u64().and_then(|d| u8::try_from(d).ok());
            product(Venue::BingxPerp, base, quote, name, decimals, t.and_then(|t| num(t.get("quoteVolume"))), t.and_then(|t| num(t.get("lastPrice"))), t.and_then(|t| percent(t.get("priceChangePercent"))))
        })
        .collect();
    Ok(unique(list))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured 2026-11-18, trimmed.
    #[test]
    fn perps_keep_open_crypto_contracts_under_bingxs_name() {
        let contracts = r#"{"code":0,"msg":"","data":[
            {"contractId":"100","symbol":"BTC-USDT","pricePrecision":1,"currency":"USDT","asset":"BTC","status":1,"apiStateOpen":"true"},
            {"contractId":"2","symbol":"1000PEPE-USDT","pricePrecision":7,"currency":"USDT","asset":"1000PEPE","status":1,"apiStateOpen":"true"},
            {"contractId":"3","symbol":"ETH-USDC","pricePrecision":2,"currency":"USDC","asset":"ETH","status":1,"apiStateOpen":"true"},
            {"contractId":"4","symbol":"NCFXEUR2USD-USDT","pricePrecision":5,"currency":"USDT","asset":"NCFXEUR2USD","status":1,"apiStateOpen":"true","displayName":"EURUSD-USDT"},
            {"contractId":"5","symbol":"NCSKRACE2USD-USDT","pricePrecision":2,"currency":"USDT","asset":"NCSKRACE2USD","status":25,"apiStateOpen":"false"},
            {"contractId":"6","symbol":"SHUT-USDT","pricePrecision":4,"currency":"USDT","asset":"SHUT","status":1,"apiStateOpen":"false"}]}"#;
        let tickers = r#"{"code":0,"msg":"","data":[{"symbol":"BTC-USDT","priceChangePercent":"-1.61","lastPrice":"64014.8","quoteVolume":"1630363151.73"}]}"#;
        let p = parse_perps(contracts, Some(tickers)).unwrap();
        assert_eq!(p.iter().map(|p| p.market.as_str()).collect::<Vec<_>>(), ["bingx-perp:BTCUSDT", "bingx-perp:1000PEPEUSDT", "bingx-perp:ETHUSDC"], "the forex contract, the closed one and the one taking no orders stay out");
        assert_eq!((p[0].native.as_deref(), p[0].price_decimals, p[0].last_price, p[0].change_pct, p[0].quote_volume_24h), (Some("BTC-USDT"), Some(1), Some(64014.8), Some(-1.61), Some(1630363151.73)));
    }

    #[test]
    fn spot_keeps_online_dollar_pairs_with_turnover() {
        let symbols = r#"{"code":0,"msg":"","data":{"symbols":[
            {"symbol":"BTC-USDT","tickSize":0.01,"status":1,"apiStateSell":true,"apiStateBuy":true},
            {"symbol":"PEPE-USDT","tickSize":0.00000001,"status":1,"apiStateSell":true,"apiStateBuy":true},
            {"symbol":"THIN-USDT","tickSize":0.0001,"status":1,"apiStateSell":true,"apiStateBuy":true},
            {"symbol":"ETH-BTC","tickSize":0.00001,"status":1,"apiStateSell":true,"apiStateBuy":true},
            {"symbol":"SWEAT-USDT","tickSize":0.000001,"status":0,"apiStateSell":true,"apiStateBuy":true}]}}"#;
        let tickers = r#"{"code":0,"timestamp":1795007227068,"data":[
            {"symbol":"BTC-USDT","lastPrice":64049.76,"priceChangePercent":"-1.62%","quoteVolume":138661008.54},
            {"symbol":"PEPE-USDT","lastPrice":0.00000412,"priceChangePercent":"3.5%","quoteVolume":2500000.0},
            {"symbol":"THIN-USDT","lastPrice":0.5,"priceChangePercent":"0%","quoteVolume":900.0},
            {"symbol":"ETH-BTC","lastPrice":0.03,"priceChangePercent":"0%","quoteVolume":90000.0}]}"#;
        let p = parse_spot(symbols, Some(tickers)).unwrap();
        assert_eq!(p.iter().map(|p| p.market.as_str()).collect::<Vec<_>>(), ["bingx-spot:BTCUSDT", "bingx-spot:PEPEUSDT"], "the thin pair, the coin pair and the offline one stay out");
        assert_eq!((p[0].native.as_deref(), p[0].price_decimals, p[0].change_pct), (Some("BTC-USDT"), Some(2), Some(-1.62)));
        assert_eq!(p[1].price_decimals, Some(8));
        assert_eq!(parse_spot(symbols, None).unwrap().len(), 3, "no ticker table, no turnover to go by");
    }
}
