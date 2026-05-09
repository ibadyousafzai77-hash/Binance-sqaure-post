const https = require("https");
const http = require("http");

const NTFY_TOPIC = "crypto-signals-bot-2024";

const SCAN_COINS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ADAUSDT", "NEARUSDT",
  "INJUSDT", "SUIUSDT", "JUPUSDT", "TIAUSDT", "SEIUSDT",
  "APTUSDT", "OPUSDT", "ARBUSDT", "LDOUSDT", "FETUSDT",
  "WIFUSDT", "BONKUSDT", "PENDLEUSDT", "RENDERUSDT", "AAVEUSDT"
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function sendNtfy(title, message, priority) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(message, "utf8");
    const safeTitle = "base64," + Buffer.from(title).toString("base64");
    const options = {
      hostname: "ntfy.sh",
      port: 443,
      path: "/" + NTFY_TOPIC,
      method: "POST",
      headers: {
        "Title": safeTitle,
        "Priority": priority || "high",
        "Tags": "chart_increasing,bell",
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.length,
      },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("ntfy timeout")); });
    req.write(body);
    req.end();
  });
}

function calcRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return 50;
  var gains = [], losses = [];
  for (var i = 1; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  var avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  var avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (var j = period; j < gains.length; j++) {
    avgGain = (avgGain * (period - 1) + gains[j]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[j]) / period;
  }
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcEMA(closes, period) {
  var k = 2 / (period + 1);
  var ema = closes[0];
  for (var i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(closes) {
  var k12 = 2 / 13, k26 = 2 / 27;
  var e12 = closes[0], e26 = closes[0];
  var macdValues = [];
  for (var i = 0; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    macdValues.push(e12 - e26);
  }
  var macdLine = macdValues[macdValues.length - 1];
  var signalLine = calcEMA(macdValues, 9);
  return { macd: macdLine, signal: signalLine };
}

function calcATR(highs, lows, period) {
  period = period || 14;
  var trs = [];
  for (var i = Math.max(1, highs.length - period); i < highs.length; i++) {
    trs.push(highs[i] - lows[i]);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function fmt(n) {
  if (n >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 100)   return n.toFixed(2);
  if (n >= 1)     return n.toFixed(3);
  if (n >= 0.01)  return n.toFixed(4);
  return n.toFixed(6);
}

async function analyseCoin(symbol) {
  var url = "https://api.binance.com/api/v3/klines?symbol=" + symbol + "&interval=15m&limit=100";
  var klines = await httpGet(url);
  if (!klines || klines.length < 50) throw new Error("Not enough data");

  var opens   = klines.map(function(k) { return parseFloat(k[1]); });
  var highs   = klines.map(function(k) { return parseFloat(k[2]); });
  var lows    = klines.map(function(k) { return parseFloat(k[3]); });
  var closes  = klines.map(function(k) { return parseFloat(k[4]); });
  var volumes = klines.map(function(k) { return parseFloat(k[5]); });

  var price    = closes[closes.length - 1];
  var rsi      = calcRSI(closes);
  var ema9     = calcEMA(closes, 9);
  var ema21    = calcEMA(closes, 21);
  var ema50    = calcEMA(closes, 50);
  var macdData = calcMACD(closes);
  var atr      = calcATR(highs, lows, 14);

  var recentVols = volumes.slice(-20, -1);
  var avgVol   = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  var volRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1;

  var last3Bullish = 0;
  for (var i = -3; i < 0; i++) {
    if (closes[closes.length + i] > opens[opens.length + i]) last3Bullish++;
  }

  var longScore = 0, shortScore = 0;

  if (rsi < 30)      { longScore  += 3; }
  else if (rsi < 45) { longScore  += 1; }
  if (rsi > 70)      { shortScore += 3; }
  else if (rsi > 55) { shortScore += 1; }

  if (macdData.macd > macdData.signal) { longScore  += 2; }
  else                                  { shortScore += 2; }

  if (price > ema9)  { longScore++; } else { shortScore++; }
  if (price > ema21) { longScore++; } else { shortScore++; }
  if (price > ema50) { longScore++; } else { shortScore++; }

  if (volRatio > 1.5) {
    if (longScore > shortScore) { longScore++;  }
    else                        { shortScore++; }
  }

  if (last3Bullish >= 2) { longScore++;  }
  else                   { shortScore++; }

  var direction  = longScore >= shortScore ? "LONG" : "SHORT";
  var scoreDiff  = Math.abs(longScore - shortScore);
  var confidence = scoreDiff >= 5 ? "STRONG" : scoreDiff >= 3 ? "MEDIUM" : "WEAK";

  var tp1, tp2, tp3, sl;
  if (direction === "LONG") {
    tp1 = price + atr * 1.5;
    tp2 = price + atr * 2.5;
    tp3 = price + atr * 4.0;
    sl  = price - atr * 1.0;
  } else {
    tp1 = price - atr * 1.5;
    tp2 = price - atr * 2.5;
    tp3 = price - atr * 4.0;
    sl  = price + atr * 1.0;
  }

  var rr = Math.abs(tp2 - price) / Math.abs(sl - price);
  var change1h  = ((closes[closes.length-1] - closes[closes.length-5])  / closes[closes.length-5])  * 100;
  var change24h = ((closes[closes.length-1] - closes[closes.length-97]) / closes[closes.length-97]) * 100;

  return {
    symbol, price, direction, confidence, scoreDiff, longScore, shortScore,
    rsi, ema9, ema21, ema50, macd: macdData.macd, macdSignal: macdData.signal,
    volRatio, atr, last3Bullish, tp1, tp2, tp3, sl, rr,
    support: Math.min.apply(null, lows.slice(-20)),
    resistance: Math.max.apply(null, highs.slice(-20)),
    change1h, change24h
  };
}

async function scanMarket() {
  console.log("Scanning " + SCAN_COINS.length + " coins...");
  var results = [];
  for (var i = 0; i < SCAN_COINS.length; i++) {
    try {
      var r = await analyseCoin(SCAN_COINS[i]);
      results.push(r);
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("x");
    }
  }
  console.log("");
  results.sort(function(a, b) {
    var confOrder = { STRONG: 3, MEDIUM: 2, WEAK: 1 };
    if (confOrder[b.confidence] !== confOrder[a.confidence]) {
      return confOrder[b.confidence] - confOrder[a.confidence];
    }
    return b.scoreDiff - a.scoreDiff;
  });
  return results;
}

function buildSignalMessage(s, rank) {
  var dir    = s.direction === "LONG" ? "LONG (BUY)" : "SHORT (SELL)";
  var chSign  = s.change1h  >= 0 ? "+" : "";
  var c24Sign = s.change24h >= 0 ? "+" : "";
  var tpSign  = s.direction === "LONG" ? "+" : "-";
  var tp1pct  = (Math.abs(s.tp1 - s.price) / s.price * 100).toFixed(2);
  var tp2pct  = (Math.abs(s.tp2 - s.price) / s.price * 100).toFixed(2);
  var tp3pct  = (Math.abs(s.tp3 - s.price) / s.price * 100).toFixed(2);
  var slpct   = (Math.abs(s.sl  - s.price) / s.price * 100).toFixed(2);
  var rsiNote  = s.rsi > 70 ? "Overbought" : s.rsi < 30 ? "Oversold" : "Neutral";
  var macdNote = s.macd > s.macdSignal ? "Bullish" : "Bearish";
  var volNote  = s.volRatio > 1.5 ? "HIGH (" + s.volRatio.toFixed(1) + "x)" : "Normal (" + s.volRatio.toFixed(1) + "x)";

  return [
    "Signal #" + rank + " | " + s.symbol,
    "Direction : " + dir + "  [" + s.confidence + "]",
    "Timeframe : 15-Minute Chart",
    "",
    "Price     : " + fmt(s.price) + " USDT",
    "1h Change : " + chSign  + s.change1h.toFixed(2)  + "%",
    "24h Change: " + c24Sign + s.change24h.toFixed(2) + "%",
    "",
    "ENTRY     : " + fmt(s.price),
    "TP1       : " + fmt(s.tp1) + "  (" + tpSign + tp1pct + "%)",
    "TP2       : " + fmt(s.tp2) + "  (" + tpSign + tp2pct + "%)",
    "TP3       : " + fmt(s.tp3) + "  (" + tpSign + tp3pct + "%)",
    "STOP LOSS : " + fmt(s.sl)  + "  (-" + slpct + "%)",
    "R:R Ratio : 1:" + s.rr.toFixed(1),
    "",
    "--- INDICATORS ---",
    "RSI(14)   : " + s.rsi.toFixed(1) + "  [" + rsiNote + "]",
    "MACD      : " + macdNote,
    "EMA 9     : " + fmt(s.ema9)  + "  [" + (s.price > s.ema9  ? "ABOVE" : "BELOW") + "]",
    "EMA 21    : " + fmt(s.ema21) + "  [" + (s.price > s.ema21 ? "ABOVE" : "BELOW") + "]",
    "EMA 50    : " + fmt(s.ema50) + "  [" + (s.price > s.ema50 ? "ABOVE" : "BELOW") + "]",
    "Volume    : " + volNote,
    "Candles   : " + s.last3Bullish + "/3 bullish",
    "Support   : " + fmt(s.support),
    "Resist.   : " + fmt(s.resistance),
    "",
    "Confirms  : " + s.longScore + " LONG vs " + s.shortScore + " SHORT",
    "",
    "Use Stop Loss. DYOR. Not financial advice.",
  ].join("\n");
}

function buildViralPost(results) {
  var top5  = results.slice(0, 5);
  var now   = new Date().toUTCString();
  var longCount   = results.filter(function(r) { return r.direction === "LONG";  }).length;
  var shortCount  = results.filter(function(r) { return r.direction === "SHORT"; }).length;
  var strongCount = results.filter(function(r) { return r.confidence === "STRONG"; }).length;
  var moodLabel   = longCount > shortCount * 1.2 ? "BULLISH" : shortCount > longCount * 1.2 ? "BEARISH" : "MIXED";

  var lines = [
    "CRYPTO MARKET SIGNALS SUMMARY",
    "Updated: " + now,
    "Based on: RSI, MACD, EMA, Volume (15-Min)",
    "",
    "TOP 5 SIGNALS RIGHT NOW:",
    "--------------------------------",
  ];

  top5.forEach(function(s, i) {
    var c = s.change24h >= 0 ? "+" + s.change24h.toFixed(1) + "%" : s.change24h.toFixed(1) + "%";
    lines.push(
      (i+1) + ". " + s.symbol.replace("USDT","") +
      "  " + s.direction + " [" + s.confidence + "]" +
      "  |  " + fmt(s.price) + "  |  24h: " + c
    );
  });

  lines.push("", "MARKET OVERVIEW:");
  lines.push("  Bullish : " + longCount  + "/" + results.length);
  lines.push("  Bearish : " + shortCount + "/" + results.length);
  lines.push("  Strong  : " + strongCount + " signals");
  lines.push("  Mood    : " + moodLabel);
  lines.push("", "RSI + MACD + EMA9/21/50 + Volume + ATR");
  lines.push("Not financial advice. Always use Stop Loss.");

  return lines.join("\n");
}

async function main() {
  var now    = new Date();
  var runNum = Math.floor(Date.now() / (10 * 60 * 1000));
  var slot   = runNum % 6;

  console.log("=== Crypto Signal Bot ===");
  console.log("Time : " + now.toISOString());
  console.log("Slot : " + slot + " --> " + (slot < 5 ? "Signal " + (slot+1) : "Viral Post"));
  console.log();

  var results = await scanMarket();
  console.log("Scanned: " + results.length + " coins");
  if (results.length === 0) throw new Error("No results from market scan");

  var title, message;

  if (slot < 5) {
    var pick = results[slot] || results[results.length - 1];
    var dirWord = pick.direction === "LONG" ? "LONG BUY" : "SHORT SELL";
    title   = "Signal #" + (slot+1) + ": " + pick.symbol + " " + dirWord + " [" + pick.confidence + "]";
    message = buildSignalMessage(pick, slot + 1);
    console.log(">> " + pick.symbol + " " + pick.direction + " [" + pick.confidence + "] Price: " + fmt(pick.price));
  } else {
    title   = "Crypto Market Summary - Top 5 Signals This Hour";
    message = buildViralPost(results);
    console.log(">> Viral post / market summary");
  }

  console.log("Sending ntfy...");
  var res = await sendNtfy(title, message, "high");
  console.log("ntfy status: " + res.status);
  if (res.status !== 200) throw new Error("ntfy failed: " + res.status + " " + res.body);
  console.log("Done!");
}

main().catch(function(err) {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
