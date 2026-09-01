const ALLOWED_SYMBOLS = new Set(["SPY", "QQQ"]);
const CACHE_SECONDS = 10;
const UPSTREAM_TIMEOUT_MS = 6500;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoFromEpoch(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

function parseYahooChart(symbol, payload) {
  const chart = payload && payload.chart;
  if (!chart) throw new Error("chart missing");
  if (chart.error) throw new Error(chart.error.description || chart.error.code || "Yahoo error");
  const result = Array.isArray(chart.result) ? chart.result[0] : null;
  if (!result) throw new Error("empty chart result");

  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators && Array.isArray(result.indicators.quote)
    ? (result.indicators.quote[0] || {})
    : {};
  const closes = Array.isArray(quote.close) ? quote.close : [];

  let price = safeNumber(meta.regularMarketPrice);
  let marketEpoch = safeNumber(meta.regularMarketTime);
  if (price === null) {
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const close = safeNumber(closes[i]);
      if (close !== null) {
        price = close;
        marketEpoch = safeNumber(timestamps[i]);
        break;
      }
    }
  }
  if (price === null) throw new Error("price missing");

  let previous = safeNumber(meta.regularMarketPreviousClose);
  if (previous === null) previous = safeNumber(meta.chartPreviousClose);
  if (previous === null) previous = safeNumber(meta.previousClose);

  const change = previous !== null ? price - previous : null;
  const changePct = previous !== null && previous !== 0 ? (change / previous) * 100 : null;
  const marketState = String(meta.marketState || "UNKNOWN").toUpperCase();
  const sessionLabels = {
    REGULAR: "通常取引",
    PRE: "プレ市場",
    POST: "時間外",
    CLOSED: "市場終了",
    PREPRE: "市場前",
    POSTPOST: "時間外",
  };

  return {
    symbol,
    price,
    previous_close: previous,
    change,
    change_pct: changePct,
    currency: meta.currency || "USD",
    market_state: marketState,
    session_label: sessionLabels[marketState] || marketState,
    exchange_timezone: meta.exchangeTimezoneName || "America/New_York",
    market_time: isoFromEpoch(marketEpoch),
    market_time_display: isoFromEpoch(marketEpoch) || "—",
    source_delay_seconds: safeNumber(meta.exchangeDataDelayedBy),
  };
}

async function fetchYahooQuote(symbol) {
  const params = new URLSearchParams({
    interval: "1m",
    range: "1d",
    includePrePost: "true",
    events: "div,splits",
  });
  const upstreamUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (compatible; AutoTradeAI-Development/0.2)",
      },
      signal: controller.signal,
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const payload = await response.json();
    return parseYahooChart(symbol, payload);
  } finally {
    clearTimeout(timer);
  }
}

async function marketQuotes(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("symbols") || "SPY,QQQ";
  const symbols = [];
  for (const item of raw.split(",")) {
    const symbol = item.trim().toUpperCase();
    if (ALLOWED_SYMBOLS.has(symbol) && !symbols.includes(symbol)) symbols.push(symbol);
  }
  if (!symbols.length) {
    return jsonResponse(400, { status: "error", error: "対応銘柄はSPY/QQQのみです" });
  }

  const results = await Promise.allSettled(symbols.map(fetchYahooQuote));
  const quotes = {};
  const errors = {};
  results.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === "fulfilled") quotes[symbol] = result.value;
    else errors[symbol] = result.reason instanceof Error ? result.reason.message : String(result.reason);
  });

  if (Object.keys(errors).length) {
    return jsonResponse(502, {
      status: "error",
      error: "上流の市場データを取得できません",
      detail: errors,
    });
  }

  return jsonResponse(200, {
    status: "ok",
    provider: "Yahoo Finance chart / development feed",
    production_ready: false,
    fetched_at: new Date().toISOString(),
    quotes,
  });
}

const INDEX_HTML = "<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\" />\n<title>AutoTrade AI V1 - Cloud Feed</title>\n<style>\n:root{\n  --bg:#0b0e14; --panel:#121722; --panel2:#171d2a; --text:#eef2f7; --muted:#93a0b4;\n  --line:#242c3b; --accent:#6da8ff; --good:#5dd39e; --bad:#ff7b86; --warn:#ffc857;\n  --shadow:0 14px 36px rgba(0,0,0,.22); --radius:18px;\n}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Noto Sans JP\",sans-serif}\nbutton,input,select{font:inherit}\nbutton{cursor:pointer}\n.app{min-height:100vh;display:grid;grid-template-columns:240px 1fr}\n.sidebar{border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh;background:#0e121a}\n.brand{font-weight:800;font-size:20px;padding:4px 10px 18px}\n.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;border:1px solid var(--line);background:var(--panel);padding:6px 9px;border-radius:999px;color:var(--muted)}\n.nav{display:flex;flex-direction:column;gap:6px;margin-top:18px}\n.nav button{border:0;background:transparent;color:var(--muted);text-align:left;padding:12px 13px;border-radius:12px}\n.nav button.active,.nav button:hover{background:var(--panel2);color:var(--text)}\n.sidebar-foot{position:absolute;left:14px;right:14px;bottom:18px;display:grid;gap:8px}\n.main{padding:22px;min-width:0}\n.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}\n.title h1{font-size:24px;margin:0}.title p{margin:6px 0 0;color:var(--muted);font-size:13px}\n.controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}\n.btn{border:1px solid var(--line);background:var(--panel);color:var(--text);padding:10px 13px;border-radius:12px}\n.btn.primary{background:var(--accent);color:#08111f;border-color:transparent;font-weight:800}.btn.danger{background:#2b1418;border-color:#5b232a;color:#ffb2b8}.btn:disabled{opacity:.45;cursor:not-allowed}\n.grid{display:grid;gap:14px}.grid.cols4{grid-template-columns:repeat(4,minmax(0,1fr))}.grid.cols3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid.cols2{grid-template-columns:repeat(2,minmax(0,1fr))}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);min-width:0}\n.card h3{margin:0 0 12px;font-size:15px}.kpi{font-size:27px;font-weight:800;letter-spacing:-.02em}.sub{font-size:12px;color:var(--muted);margin-top:5px}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}\n.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.stack{display:grid;gap:10px}.divider{height:1px;background:var(--line);margin:12px 0}\n.pill{font-size:12px;padding:5px 8px;border-radius:999px;background:var(--panel2);color:var(--muted)}\n.status-dot{width:9px;height:9px;border-radius:50%;background:var(--good);display:inline-block}.status-dot.off{background:var(--bad)}\n.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px}.table{width:100%;border-collapse:collapse;min-width:680px}.table th,.table td{padding:12px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}.table th{color:var(--muted);font-weight:600;background:#101520}.table tr:last-child td{border-bottom:0}\n.metric-bar{height:9px;background:#0d1118;border-radius:999px;overflow:hidden}.metric-bar span{display:block;height:100%;background:var(--accent);border-radius:999px}\n.analysis-score{font-size:44px;font-weight:900;line-height:1}.scenario{display:grid;grid-template-columns:90px 1fr 70px;gap:8px;align-items:center;font-size:13px}\n.calendar-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}.dow{font-size:11px;color:var(--muted);text-align:center;padding:4px}.day{min-height:82px;border:1px solid var(--line);background:#0f141e;border-radius:12px;padding:8px;display:flex;flex-direction:column;justify-content:space-between;text-align:left;color:var(--text)}.day:hover{border-color:#3a465e}.day.blank{opacity:.2;pointer-events:none}.daynum{font-size:12px;color:var(--muted)}.pnl{font-size:14px;font-weight:800}.day.win{background:#102019}.day.loss{background:#231419}.day.flat{background:#121722}\n.notice{padding:11px 12px;border:1px solid var(--line);border-radius:12px;background:#101520;color:var(--muted);font-size:13px}.notice strong{color:var(--text)}\n.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.tabs button{border:1px solid var(--line);background:transparent;color:var(--muted);padding:8px 10px;border-radius:10px}.tabs button.active{background:var(--panel2);color:var(--text)}\n.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}.field input,.field select{width:100%;border:1px solid var(--line);background:#0e131c;color:var(--text);padding:11px 12px;border-radius:11px;outline:none}.field input:focus,.field select:focus{border-color:var(--accent)}\n.toggle{display:inline-flex;align-items:center;gap:8px}.switch{width:48px;height:28px;border-radius:999px;background:#313a4d;border:0;padding:3px;transition:.2s}.switch span{display:block;width:22px;height:22px;border-radius:50%;background:white;transition:.2s}.switch.on{background:var(--good)}.switch.on span{transform:translateX(20px)}\n.spark{height:130px;width:100%}.spark svg{width:100%;height:100%;display:block}.spark path{fill:none;stroke:var(--accent);stroke-width:3}.spark .area{fill:rgba(109,168,255,.08);stroke:none}\n.section{display:none}.section.active{display:block}\n.market-quote{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.market-symbol{font-size:13px;font-weight:800}.market-price{font-size:30px;font-weight:900;letter-spacing:-.02em}.market-change{font-size:14px;font-weight:800;text-align:right}.market-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.feed-ok{color:var(--good)}.feed-error{color:var(--bad)}.feed-loading{color:var(--warn)}\n.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.62);display:none;align-items:center;justify-content:center;padding:18px;z-index:20}.modal-backdrop.open{display:flex}.modal{width:min(680px,100%);max-height:88vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px}.modal h2{margin:0 0 12px;font-size:20px}\n.mobile-nav{display:none}\n@media(max-width:980px){.grid.cols4{grid-template-columns:repeat(2,minmax(0,1fr))}.grid.cols3{grid-template-columns:1fr 1fr}.app{grid-template-columns:190px 1fr}.sidebar{padding-left:10px;padding-right:10px}}\n@media(max-width:720px){body{padding-bottom:72px}.app{display:block}.sidebar{display:none}.main{padding:14px}.topbar{align-items:flex-start}.title h1{font-size:21px}.controls .btn:not(.keep){display:none}.grid.cols4,.grid.cols3,.grid.cols2,.form-grid{grid-template-columns:1fr}.calendar-grid{gap:4px}.day{min-height:66px;padding:6px}.pnl{font-size:12px}.mobile-nav{display:grid;grid-template-columns:repeat(7,1fr);position:fixed;left:0;right:0;bottom:0;z-index:15;background:#0f141d;border-top:1px solid var(--line);padding:6px 4px calc(6px + env(safe-area-inset-bottom))}.mobile-nav button{border:0;background:transparent;color:var(--muted);font-size:10px;padding:8px 2px}.mobile-nav button.active{color:var(--accent)}.analysis-score{font-size:38px}}\n</style>\n</head>\n<body>\n<div class=\"app\" id=\"app\">\n  <aside class=\"sidebar\">\n    <div class=\"brand\">AutoTrade AI</div>\n    <span class=\"badge\"><span class=\"status-dot off\"></span> V1 / CLOUD FEED</span>\n    <nav class=\"nav\" id=\"desktopNav\">\n      <button data-page=\"home\" class=\"active\">ホーム</button>\n      <button data-page=\"analysis\">AI分析</button>\n      <button data-page=\"trading\">取引</button>\n      <button data-page=\"calendar\">損益カレンダー</button>\n      <button data-page=\"history\">AI記録・過去分析</button>\n      <button data-page=\"weekly\">週間レポート</button>\n      <button data-page=\"settings\">設定</button>\n    </nav>\n    <div class=\"sidebar-foot\">\n      <button class=\"btn danger\" id=\"emergencyBtn\">緊急停止</button>\n      <div class=\"badge\">実注文は未接続</div>\n    </div>\n  </aside>\n\n  <main class=\"main\">\n    <header class=\"topbar\">\n      <div class=\"title\"><h1 id=\"pageTitle\">ホーム</h1><p id=\"systemSubtitle\">市場データ接続中 / 証券口座・AIは未接続</p></div>\n      <div class=\"controls\">\n        <button class=\"btn keep\" id=\"refreshMarketBtn\">価格更新</button>\n        <button class=\"btn\" id=\"currencyBtn\">表示: 円</button>\n        <button class=\"btn keep\" id=\"autoTradeBtn\">自動売買: OFF</button>\n      </div>\n    </header>\n\n    <section id=\"home\" class=\"section active\">\n      <div class=\"grid cols4\">\n        <div class=\"card\"><div class=\"sub\">総資産</div><div class=\"kpi\">未接続</div><div class=\"sub\">Paper Trading口座接続後に表示</div></div>\n        <div class=\"card\"><div class=\"sub\">本日の損益</div><div class=\"kpi\">—</div><div class=\"sub\">口座データなし</div></div>\n        <div class=\"card\"><div class=\"sub\">現在の投入比率</div><div class=\"kpi\">—</div><div class=\"sub\">上限 30%</div></div>\n        <div class=\"card\"><div class=\"sub\">市場データ</div><div class=\"kpi warn\" id=\"marketSystemStatus\" style=\"font-size:20px\"><span class=\"status-dot off\"></span> 接続待ち</div><div class=\"sub\" id=\"marketSystemSub\">サーバー経由でSPY・QQQを取得します</div></div>\n      </div>\n      <div class=\"grid cols2\" style=\"margin-top:14px\" id=\"marketQuotes\">\n        <div class=\"card\">\n          <div class=\"market-quote\"><div><div class=\"market-symbol\">SPY</div><div class=\"market-price\" id=\"spyPrice\">—</div></div><div><div class=\"market-change\" id=\"spyChange\">—</div><div class=\"sub\" style=\"text-align:right\">前日比</div></div></div>\n          <div class=\"market-meta\"><span class=\"pill\" id=\"spyMarketState\">取得待ち</span><span class=\"pill\" id=\"spyTime\">時刻 —</span></div>\n        </div>\n        <div class=\"card\">\n          <div class=\"market-quote\"><div><div class=\"market-symbol\">QQQ</div><div class=\"market-price\" id=\"qqqPrice\">—</div></div><div><div class=\"market-change\" id=\"qqqChange\">—</div><div class=\"sub\" style=\"text-align:right\">前日比</div></div></div>\n          <div class=\"market-meta\"><span class=\"pill\" id=\"qqqMarketState\">取得待ち</span><span class=\"pill\" id=\"qqqTime\">時刻 —</span></div>\n        </div>\n      </div>\n      <div class=\"notice\" id=\"marketFeedNotice\" style=\"margin-top:14px\"><strong>市場データ:</strong> 接続待ち。サーバー経由で取得し、架空価格は表示しません。</div>\n\n      <div class=\"grid cols2\" style=\"margin-top:14px\">\n        <div class=\"card\">\n          <div class=\"row\"><h3>AI現在評価</h3><span class=\"pill\">市場レジーム: 未分析</span></div>\n          <div class=\"grid cols2\">\n            <div><div class=\"sub\">SPY</div><div class=\"analysis-score\">—</div><div class=\"sub\">期待値 —</div><div class=\"metric-bar\"><span style=\"width:0%\"></span></div></div>\n            <div><div class=\"sub\">QQQ</div><div class=\"analysis-score\">—</div><div class=\"sub\">期待値 —</div><div class=\"metric-bar\"><span style=\"width:0%\"></span></div></div>\n          </div>\n          <div class=\"divider\"></div>\n          <div class=\"notice\"><strong>現在の判断:</strong> AI分析未接続。実データ接続後に表示します。</div>\n        </div>\n        <div class=\"card\">\n          <div class=\"row\"><h3>資産推移</h3><span class=\"pill\">ベンチマーク未計測</span></div>\n          <div class=\"notice\">口座接続後、総資産の推移とSPY買い持ちとの比較をここに表示します。</div>\n          <div class=\"divider\"></div>\n          <div class=\"row\"><span class=\"sub\">最大ドローダウン</span><strong>—</strong></div>\n        </div>\n      </div>\n      <div class=\"grid cols3\" style=\"margin-top:14px\">\n        <div class=\"card\"><h3>SPY 保有</h3><div class=\"row\"><span>状態</span><strong>保有なし</strong></div><div class=\"row\"><span>投入</span><strong>—</strong></div><div class=\"row\"><span>含み損益</span><strong>—</strong></div></div>\n        <div class=\"card\"><h3>QQQ 保有</h3><div class=\"row\"><span>状態</span><strong>保有なし</strong></div><div class=\"row\"><span>投入</span><strong>—</strong></div><div class=\"row\"><span>含み損益</span><strong>—</strong></div></div>\n        <div class=\"card\"><h3>本日の監視</h3><div class=\"stack\"><span class=\"notice\">重要イベント: 未取得</span><span class=\"notice\">情報取得: 未開始</span><span class=\"notice\">未約定注文: —</span></div></div>\n      </div>\n    </section>\n\n    <section id=\"analysis\" class=\"section\">\n      <div class=\"grid cols2\">\n        <div class=\"card\">\n          <div class=\"row\"><h3>QQQ 総合分析</h3><span class=\"pill\">未分析</span></div><div class=\"row\" style=\"margin-bottom:12px\"><span class=\"sub\">現在価格</span><strong id=\"qqqAnalysisPrice\">—</strong></div>\n          <div class=\"scenario\"><span>上昇</span><div class=\"metric-bar\"><span style=\"width:0%\"></span></div><strong>—</strong></div>\n          <div class=\"scenario\"><span>横ばい</span><div class=\"metric-bar\"><span style=\"width:0%\"></span></div><strong>—</strong></div>\n          <div class=\"scenario\"><span>下落</span><div class=\"metric-bar\"><span style=\"width:0%\"></span></div><strong>—</strong></div>\n          <div class=\"divider\"></div>\n          <div class=\"row\"><span>予想期間</span><strong>1〜5日</strong></div><div class=\"row\"><span>期待値</span><strong>—</strong></div><div class=\"row\"><span>推奨投入</span><strong>—</strong></div>\n        </div>\n        <div class=\"card\"><h3>判断材料</h3><div class=\"notice\">市場データ・経済指標・ニュース・金利・VIX等の接続後に、プラス材料／マイナス材料と信頼度を表示します。</div></div>\n      </div>\n      <div class=\"grid cols2\" style=\"margin-top:14px\">\n        <div class=\"card\"><h3>市場レジーム</h3><div class=\"kpi\" style=\"font-size:24px\">未分析</div><div class=\"sub\">実データ取得後に判定</div></div>\n        <div class=\"card\"><h3>撤退条件</h3><div class=\"stack\"><span class=\"notice\">市場状況に応じて自動設定</span><span class=\"notice\">1取引の想定最大損失は総資金1.5%以内</span><span class=\"notice\">上昇シナリオ崩壊時は撤退候補</span><span class=\"notice\">重大ニュース発生時は即再分析</span></div></div>\n      </div>\n    </section>\n\n    <section id=\"trading\" class=\"section\">\n      <div class=\"card\">\n        <div class=\"row\"><h3>現在の保有</h3><button class=\"btn danger\" id=\"sellAllBtn\">全ポジション売却</button></div>\n        <div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>銘柄</th><th>投入比率</th><th>買値</th><th>現在値</th><th>損益</th><th>AI判断</th><th>撤退条件</th></tr></thead><tbody><tr><td colspan=\"7\" class=\"sub\">保有ポジションはありません。口座未接続です。</td></tr></tbody></table></div>\n      </div>\n      <div class=\"card\" style=\"margin-top:14px\"><h3>最近の注文</h3><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>日時</th><th>銘柄</th><th>種別</th><th>状態</th><th>数量</th><th>約定価格</th><th>注文ID</th></tr></thead><tbody><tr><td colspan=\"7\" class=\"sub\">注文履歴はありません。</td></tr></tbody></table></div></div>\n    </section>\n\n    <section id=\"calendar\" class=\"section\">\n      <div class=\"card\">\n        <div class=\"calendar-head\"><div><h3 style=\"margin-bottom:4px\">2026年9月</h3><div class=\"sub\">日次損益 = 入出金を除いた口座資産の前日比</div></div><button class=\"btn primary\" id=\"monthSummaryBtn\">月収支</button></div>\n        <div class=\"calendar-grid\" id=\"calendarGrid\"></div>\n      </div>\n      <div class=\"grid cols4\" style=\"margin-top:14px\"><div class=\"card\"><div class=\"sub\">今月</div><div class=\"kpi\">—</div></div><div class=\"card\"><div class=\"sub\">勝ち日</div><div class=\"kpi\">—</div></div><div class=\"card\"><div class=\"sub\">負け日</div><div class=\"kpi\">—</div></div><div class=\"card\"><div class=\"sub\">最大マイナス</div><div class=\"kpi\">—</div></div></div>\n    </section>\n\n    <section id=\"history\" class=\"section\">\n      <div class=\"grid cols3\"><div class=\"card\"><div class=\"sub\">記録済みAI判断</div><div class=\"kpi\">0</div><div class=\"sub\">売買＋見送り</div></div><div class=\"card\"><div class=\"sub\">過去検証</div><div class=\"kpi warn\">未実行</div><div class=\"sub\">目標期間: 過去10年</div></div><div class=\"card\"><div class=\"sub\">ウォークフォワード</div><div class=\"kpi warn\">未実行</div><div class=\"sub\">バックテスト実装後に開始</div></div></div>\n      <div class=\"card\" style=\"margin-top:14px\"><h3>AI評価点の答え合わせ</h3><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>評価帯</th><th>判断数</th><th>勝率</th><th>平均利益</th><th>平均損失</th><th>期待値</th></tr></thead><tbody><tr><td colspan=\"6\" class=\"sub\">まだ評価データはありません。</td></tr></tbody></table></div></div>\n      <div class=\"card\" style=\"margin-top:14px\"><h3>最近の判断ログ</h3><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>日時</th><th>銘柄</th><th>判断</th><th>評価</th><th>期待値</th><th>結果</th><th>事後評価</th></tr></thead><tbody><tr><td colspan=\"7\" class=\"sub\">AI判断ログはありません。</td></tr></tbody></table></div></div>\n    </section>\n\n    <section id=\"weekly\" class=\"section\">\n      <div class=\"grid cols4\"><div class=\"card\"><div class=\"sub\">第1週</div><div class=\"kpi\">—</div><div class=\"sub\">未開始</div></div><div class=\"card\"><div class=\"sub\">第2週</div><div class=\"kpi\">—</div><div class=\"sub\">未開始</div></div><div class=\"card\"><div class=\"sub\">第3週</div><div class=\"kpi\">—</div><div class=\"sub\">未開始</div></div><div class=\"card\"><div class=\"sub\">28日総合</div><div class=\"kpi\">—</div><div class=\"sub\">未判定</div></div></div>\n      <div class=\"grid cols2\" style=\"margin-top:14px\"><div class=\"card\"><h3>良かった点</h3><div class=\"notice\">7日間の運用後に自動生成します。</div></div><div class=\"card\"><h3>反省点</h3><div class=\"notice\">7日間の運用後に自動生成します。</div></div></div>\n      <div class=\"card\" style=\"margin-top:14px\"><h3>改善フロー</h3><div class=\"notice\"><strong>改善案 → 過去データで再検証 → デモ比較 → 改善確認 → 採用</strong><br>AIが本番ルールを勝手に書き換えることは禁止。</div></div>\n    </section>\n\n    <section id=\"settings\" class=\"section\">\n      <div class=\"grid cols2\">\n        <div class=\"card\"><h3>売買設定</h3><div class=\"form-grid\"><div class=\"field\"><label>モード</label><select><option>デモ</option><option disabled>本番（未接続）</option></select></div><div class=\"field\"><label>1銘柄上限</label><input value=\"20%\" readonly></div><div class=\"field\"><label>SPY+QQQ 合計上限</label><input value=\"30%\" readonly></div><div class=\"field\"><label>1取引 想定最大損失</label><input value=\"1.5%\" readonly></div><div class=\"field\"><label>1日 最大損失</label><input value=\"3%\" readonly></div><div class=\"field\"><label>基本戦略</label><input value=\"1〜5日 スイング / 買いのみ\" readonly></div></div></div>\n        <div class=\"card\"><h3>システム</h3><div class=\"stack\"><div class=\"row\"><span>自動売買</span><button class=\"switch\" id=\"switchAuto\"><span></span></button></div><div class=\"row\"><span>新規購入</span><button class=\"switch\" id=\"switchEntry\"><span></span></button></div><div class=\"row\"><span>異常通知</span><button class=\"switch on\" id=\"switchAlert\"><span></span></button></div><div class=\"row\"><span>売買通知</span><button class=\"switch on\" id=\"switchTradeNotify\"><span></span></button></div></div><div class=\"divider\"></div><div class=\"notice\">APIキー・Secretはブラウザ保存しない設計。実接続時はサーバー側の安全な保管領域に置く。</div></div>\n      </div>\n      <div class=\"card\" style=\"margin-top:14px\"><h3>接続状態</h3><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>項目</th><th>状態</th><th>備考</th></tr></thead><tbody><tr><td>証券API</td><td class=\"warn\">未接続</td><td>次工程でPaper Trading接続</td></tr><tr><td>市場データ</td><td class=\"warn\" id=\"marketConnectionState\">接続待ち</td><td id=\"marketConnectionNote\">SPY・QQQ開発フィード</td></tr><tr><td>ニュース</td><td class=\"warn\">未接続</td><td>無料中心で順次接続</td></tr><tr><td>AI分析</td><td class=\"warn\">未接続</td><td>実モデル接続前</td></tr></tbody></table></div></div>\n    </section>\n  </main>\n</div>\n\n<nav class=\"mobile-nav\" id=\"mobileNav\">\n  <button data-page=\"home\" class=\"active\">ホーム</button><button data-page=\"analysis\">AI</button><button data-page=\"trading\">取引</button><button data-page=\"calendar\">損益</button><button data-page=\"history\">記録</button><button data-page=\"weekly\">週次</button><button data-page=\"settings\">設定</button>\n</nav>\n\n<div class=\"modal-backdrop\" id=\"modalBackdrop\"><div class=\"modal\"><div class=\"row\"><h2 id=\"modalTitle\">詳細</h2><button class=\"btn\" id=\"modalClose\">閉じる</button></div><div id=\"modalBody\"></div></div></div>\n\n<script>\n(function(){\n  const state={currency:'JPY',auto:false,entry:false,emergency:false,market:{quotes:{},status:'idle',provider:null,lastFetch:null}};\n  const titles={home:'ホーム',analysis:'AI分析',trading:'取引',calendar:'損益カレンダー',history:'AI記録・過去分析',weekly:'週間レポート',settings:'設定'};\n  const calendarData={};\n  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];\n  function switchPage(page){\n    $$('.section').forEach(el=>el.classList.toggle('active',el.id===page));\n    $$('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===page));\n    $('#pageTitle').textContent=titles[page]||page;\n    window.scrollTo({top:0,behavior:'smooth'});\n  }\n  $$('[data-page]').forEach(b=>b.addEventListener('click',()=>switchPage(b.dataset.page)));\n\n\n\n  const MARKET_REFRESH_MS=15000;\n  let marketTimer=null;\n  function formatPrice(value,currency='USD'){\n    if(!Number.isFinite(value)) return '—';\n    if(currency==='USD') return '$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});\n    return value.toLocaleString('ja-JP',{maximumFractionDigits:2});\n  }\n  function formatPct(value){\n    if(!Number.isFinite(value)) return '—';\n    return (value>0?'+':'')+value.toFixed(2)+'%';\n  }\n  function setText(id,text){const el=$('#'+id);if(el)el.textContent=text}\n  function setClass(id,kind){const el=$('#'+id);if(!el)return;el.classList.remove('good','bad','warn','feed-ok','feed-error','feed-loading');if(kind)el.classList.add(kind)}\n  function renderMarketQuote(symbol){\n    const q=state.market.quotes[symbol];\n    const lower=symbol.toLowerCase();\n    if(!q){\n      setText(lower+'Price','—');setText(lower+'Change','—');setText(lower+'MarketState','取得待ち');setText(lower+'Time','時刻 —');\n      if(symbol==='QQQ')setText('qqqAnalysisPrice','—');\n      return;\n    }\n    setText(lower+'Price',formatPrice(q.price,q.currency));\n    setText(lower+'Change',formatPct(q.change_pct));\n    setClass(lower+'Change',q.change_pct>0?'good':q.change_pct<0?'bad':null);\n    setText(lower+'MarketState',q.session_label||'市場データ');\n    setText(lower+'Time',q.market_time_display||'時刻 —');\n    if(symbol==='QQQ')setText('qqqAnalysisPrice',formatPrice(q.price,q.currency));\n  }\n  function renderMarketStatus(){\n    const status=state.market.status;\n    const statusEl=$('#marketSystemStatus');\n    if(status==='ok'){\n      if(statusEl){statusEl.className='kpi feed-ok';statusEl.style.fontSize='20px';statusEl.innerHTML='<span class=\"status-dot\"></span> 取得中';}\n      setText('marketSystemSub','SPY・QQQを15秒ごとに更新');\n      setText('marketConnectionState','接続中');setClass('marketConnectionState','good');\n      setText('marketConnectionNote',(state.market.provider||'開発フィード')+' / 本番データ源は後で差替');\n      const fetched=state.market.lastFetch?new Date(state.market.lastFetch).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';\n      const notice=$('#marketFeedNotice');if(notice)notice.innerHTML='<strong>市場データ:</strong> '+(state.market.provider||'開発フィード')+' / 最終取得 '+fetched+'。開発用フィードのため遅延する可能性があります。';\n      setText('systemSubtitle','SPY・QQQ市場データ取得中 / 証券口座・AIは未接続');\n    }else if(status==='loading'){\n      if(statusEl){statusEl.className='kpi feed-loading';statusEl.style.fontSize='20px';statusEl.innerHTML='<span class=\"status-dot off\"></span> 取得中…';}\n      setText('marketConnectionState','取得中');setClass('marketConnectionState','warn');\n    }else if(status==='error'){\n      if(statusEl){statusEl.className='kpi feed-error';statusEl.style.fontSize='20px';statusEl.innerHTML='<span class=\"status-dot off\"></span> 取得失敗';}\n      setText('marketSystemSub','価格は空欄のまま保持します');\n      setText('marketConnectionState','取得失敗');setClass('marketConnectionState','bad');\n      setText('marketConnectionNote','サーバーまたは上流データを確認');\n      const notice=$('#marketFeedNotice');if(notice)notice.innerHTML='<strong>市場データ:</strong> '+(state.market.error||'取得できませんでした')+'。架空価格へのフォールバックはしません。';\n      setText('systemSubtitle','市場データ取得失敗 / 証券口座・AIは未接続');\n    }else{\n      setText('marketConnectionState','接続待ち');setClass('marketConnectionState','warn');\n    }\n  }\n  async function fetchMarketQuotes(manual=false){\n    if(state.market.status==='loading'&&!manual)return;\n    state.market.status='loading';renderMarketStatus();\n    const controller=new AbortController();\n    const timeout=setTimeout(()=>controller.abort(),8000);\n    try{\n      const res=await fetch('/api/market/quotes?symbols=SPY,QQQ',{cache:'no-store',signal:controller.signal});\n      let payload=null;\n      try{payload=await res.json()}catch(_){throw new Error('市場データAPIの応答形式が不正')}\n      if(!res.ok||payload.status!=='ok')throw new Error(payload.error||('HTTP '+res.status));\n      if(!payload.quotes||!payload.quotes.SPY||!payload.quotes.QQQ)throw new Error('SPY/QQQの価格が揃っていません');\n      state.market.quotes=payload.quotes;\n      state.market.provider=payload.provider||'開発フィード';\n      state.market.lastFetch=payload.fetched_at||new Date().toISOString();\n      state.market.status='ok';state.market.error=null;\n      renderMarketQuote('SPY');renderMarketQuote('QQQ');renderMarketStatus();\n    }catch(err){\n      state.market.status='error';\n      state.market.error=(location.protocol==='file:'?'単体HTMLでは価格取得できません。サーバー版で接続します。':(err.name==='AbortError'?'取得がタイムアウトしました':err.message));\n      renderMarketStatus();\n    }finally{clearTimeout(timeout)}\n  }\n\n  function money(n){\n    if(state.currency==='JPY') return (n>=0?'+':'-')+'¥'+Math.abs(Math.round(n)).toLocaleString('ja-JP');\n    const usd=n/145; return (usd>=0?'+':'-')+'$'+Math.abs(usd).toFixed(2);\n  }\n  $('#currencyBtn').addEventListener('click',()=>{state.currency=state.currency==='JPY'?'USD':'JPY';$('#currencyBtn').textContent='表示: '+(state.currency==='JPY'?'円':'ドル');$$('[data-money]').forEach(el=>{const n=Number(el.dataset.money);el.textContent=money(n)});renderCalendar();});\n\n  function setAuto(v){state.auto=v;$('#autoTradeBtn').textContent='自動売買: '+(v?'ON':'OFF');$('#switchAuto').classList.toggle('on',v)}\n  $('#autoTradeBtn').addEventListener('click',()=>setAuto(!state.auto));\n  $('#switchAuto').addEventListener('click',()=>setAuto(!state.auto));\n  $('#switchEntry').addEventListener('click',e=>{state.entry=!state.entry;e.currentTarget.classList.toggle('on',state.entry)});\n  ['switchAlert','switchTradeNotify'].forEach(id=>$('#'+id).addEventListener('click',e=>e.currentTarget.classList.toggle('on')));\n\n  function openModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modalBackdrop').classList.add('open')}\n  function closeModal(){$('#modalBackdrop').classList.remove('open')}\n  $('#modalClose').addEventListener('click',closeModal);$('#modalBackdrop').addEventListener('click',e=>{if(e.target===$('#modalBackdrop'))closeModal()});\n\n  $('#emergencyBtn').addEventListener('click',()=>{state.emergency=true;setAuto(false);state.entry=false;$('#switchEntry').classList.remove('on');openModal('緊急停止','<div class=\"notice\"><strong>緊急停止状態にしました。</strong><br>新規購入を停止し、自動売買をOFFにしました。実注文は未接続のため、外部口座への操作はありません。</div>')});\n  $('#sellAllBtn').addEventListener('click',()=>openModal('全ポジション売却','<div class=\"notice\">現在は口座未接続のため、売却できるポジションはありません。Paper Trading接続後に二重確認と注文状態照合を実装します。</div>'));\n\n  function renderCalendar(){\n    const grid=$('#calendarGrid');grid.innerHTML='';['月','火','水','木','金','土','日'].forEach(d=>{const e=document.createElement('div');e.className='dow';e.textContent=d;grid.appendChild(e)});\n    const startBlanks=1; for(let i=0;i<startBlanks;i++){const b=document.createElement('div');b.className='day blank';grid.appendChild(b)}\n    for(let d=1;d<=30;d++){\n      const b=document.createElement('button');b.type='button';b.className='day flat';\n      b.innerHTML='<span class=\"daynum\">'+d+'</span><span class=\"pnl\">—</span>';\n      b.addEventListener('click',()=>openModal('9月'+d+'日','<div class=\"notice\">この日の損益データはまだありません。口座接続後、日次損益・SPY/QQQ内訳・取引・AI事後評価を表示します。</div>'));\n      grid.appendChild(b)\n    }\n  }\n  renderCalendar();\n  $('#monthSummaryBtn').addEventListener('click',()=>openModal('9月 月収支','<div class=\"notice\"><strong>月収支データはまだありません。</strong><br>口座接続後、月間損益・損益率・SPY/QQQ収支・為替影響・手数料・勝敗日・AI月間評価を表示します。</div>'));\n  $('#refreshMarketBtn').addEventListener('click',()=>fetchMarketQuotes(true));\n  fetchMarketQuotes();\n  marketTimer=setInterval(fetchMarketQuotes,MARKET_REFRESH_MS);\n})();\n</script>\n</body>\n</html>\n";

function htmlResponse() {
  return new Response(INDEX_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse(200, {
        status: "ok",
        service: "autotrade-ai-v1",
        ui: "embedded",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/market/quotes") {
      return marketQuotes(request);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return htmlResponse();
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
