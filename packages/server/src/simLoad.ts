import { writeFileSync } from 'node:fs';

/**
 * The simulator's showpiece live explain (`cora start --sim`): a load test of a search API, as a session would keep
 * one, its numbers streaming in every second (throughput, latency percentiles, a latency heatmap, per endpoint), and
 * what it found turning up as it goes. Made up; for trying the Spotlight and for screenshots.
 */
const WINDOW = 90;
const BUCKETS = 22;
/** the heatmap's latency buckets: log-spaced, 4 ms to 2 s */
const EDGES = Array.from({ length: BUCKETS + 1 }, (_, i) => 4 * Math.pow(500, i / BUCKETS));

export const LOAD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Search API load test</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 22px 24px; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
  .top { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  h1 { margin: 0; font-size: 21px; font-weight: 680; letter-spacing: -.01em; }
  .live { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 700; letter-spacing: .12em; color: var(--bad); }
  .live i { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; transform: scale(.7); } }
  .phase { color: var(--ink3); font-size: 13px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .card { position: relative; overflow: hidden; background: var(--panel); border: 1px solid var(--hair); border-radius: 14px; padding: 13px 15px 10px; }
  .k { color: var(--ink3); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
  .v { font-size: 30px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .v small { font-size: 13px; color: var(--ink3); font-weight: 500; margin-left: 3px; }
  .card canvas.spark { display: block; width: 100%; height: 34px; margin-top: 4px; }
  .card.hot { border-color: color-mix(in srgb, var(--bad) 55%, var(--hair)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bad) 30%, transparent), 0 0 28px color-mix(in srgb, var(--bad) 18%, transparent); }
  .card.hot .v { color: var(--bad); }
  .row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 12px; margin-bottom: 12px; }
  @media (max-width: 900px) { .row { grid-template-columns: 1fr; } }
  .chart { height: 220px; position: relative; margin-top: 8px; }
  #heat { display: block; width: 100%; height: 220px; margin-top: 8px; border-radius: 8px; }
  .axis { display: flex; justify-content: space-between; color: var(--ink3); font-size: 10.5px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
  td { padding: 7px 4px; border-top: 1px solid var(--hair); font-size: 13px; }
  td.n { font-family: ui-monospace, monospace; color: var(--ink2); }
  td.r { text-align: right; color: var(--ink2); width: 70px; }
  .lat { width: 42%; }
  .lat b { display: block; height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--ok), var(--cora)); transition: width .6s ease; }
  .lat b.slow { background: linear-gradient(90deg, var(--warn), var(--bad)); }
  .finding { display: none; gap: 14px; align-items: flex-start; padding: 14px 16px; border-radius: 14px; background: color-mix(in srgb, var(--cora) 10%, var(--panel)); border: 1px solid color-mix(in srgb, var(--cora) 45%, var(--hair)); animation: rise .6s ease both; }
  .finding.on { display: flex; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  .finding .ic { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--cora); color: var(--bg); font-weight: 800; }
  .finding h3 { margin: 0 0 3px; font-size: 14.5px; } .finding p { margin: 0; color: var(--ink2); font-size: 13px; }
  .legend { display: flex; gap: 14px; font-size: 11.5px; color: var(--ink3); margin-top: 2px; }
  .legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
</style></head><body>
<div class="top"><h1>Search API · load test</h1><span class="live"><i></i>LIVE</span><span class="phase" id="phase">warming up…</span></div>
<div class="stats">
  <div class="card"><div class="k">Throughput</div><div class="v" id="rps">–</div><canvas class="spark" id="s-rps"></canvas></div>
  <div class="card"><div class="k">p95 latency</div><div class="v" id="p95">–</div><canvas class="spark" id="s-p95"></canvas></div>
  <div class="card" id="c-p99"><div class="k">p99 latency</div><div class="v" id="p99">–</div><canvas class="spark" id="s-p99"></canvas></div>
  <div class="card" id="c-err"><div class="k">Errors</div><div class="v" id="err">–</div><canvas class="spark" id="s-err"></canvas></div>
  <div class="card"><div class="k">Virtual users</div><div class="v" id="vus">–</div><canvas class="spark" id="s-vus"></canvas></div>
</div>
<div class="row">
  <div class="card"><div class="k">Throughput and latency · last 90 s</div>
    <div class="legend"><span><i style="background:var(--cora)"></i>requests/s</span><span><i style="background:var(--ok)"></i>p50</span><span><i style="background:var(--warn)"></i>p95</span><span><i style="background:var(--bad)"></i>p99</span></div>
    <div class="chart"><canvas id="main"></canvas></div></div>
  <div class="card"><div class="k">Latency heatmap · every request</div><canvas id="heat"></canvas><div class="axis"><span>90 s ago</span><span>now</span></div></div>
</div>
<div class="row">
  <div class="card"><div class="k">By endpoint</div><table id="eps"></table></div>
  <div class="finding" id="finding"><div class="ic">!</div><div><h3 id="f-h"></h3><p id="f-p"></p></div></div>
</div>
<script>
  var css = getComputedStyle(document.documentElement), c = function (n) { return css.getPropertyValue(n).trim() || '#888'; };
  var COL = { cora: c('--cora'), ok: c('--ok'), warn: c('--warn'), bad: c('--bad'), ink3: c('--ink3'), hair: c('--hair'), panel2: c('--panel2') };
  function alpha(col, a) { var x = document.createElement('canvas').getContext('2d'); x.fillStyle = col; var h = x.fillStyle; if (h[0] !== '#') return col; var n = parseInt(h.slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
  var main = window.Chart ? new Chart(document.getElementById('main'), {
    data: { labels: [], datasets: [
      { type: 'line', label: 'rps', data: [], yAxisID: 'r', borderColor: COL.cora, backgroundColor: alpha(COL.cora, .16), fill: true, borderWidth: 2, pointRadius: 0, tension: .35 },
      { type: 'line', label: 'p50', data: [], yAxisID: 'l', borderColor: COL.ok, borderWidth: 1.6, pointRadius: 0, tension: .35 },
      { type: 'line', label: 'p95', data: [], yAxisID: 'l', borderColor: COL.warn, borderWidth: 1.6, pointRadius: 0, tension: .35 },
      { type: 'line', label: 'p99', data: [], yAxisID: 'l', borderColor: COL.bad, borderWidth: 1.8, pointRadius: 0, tension: .3 }] },
    options: { animation: false, maintainAspectRatio: false, interaction: { intersect: false }, plugins: { legend: { display: false } },
      scales: { x: { ticks: { display: false }, grid: { display: false } },
        r: { position: 'left', min: 0, ticks: { color: COL.ink3, maxTicksLimit: 5 }, grid: { color: alpha(COL.hair, .6) } },
        l: { position: 'right', min: 0, ticks: { color: COL.ink3, maxTicksLimit: 5, callback: function (v) { return v + ' ms'; } }, grid: { display: false } } } }
  }) : null;
  function spark(id, vals, col) {
    var cv = document.getElementById(id), w = cv.clientWidth, h = cv.clientHeight, x = cv.getContext('2d');
    cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio; x.scale(devicePixelRatio, devicePixelRatio);
    var max = Math.max.apply(null, vals.concat([1e-9])), n = vals.length;
    x.beginPath(); vals.forEach(function (v, i) { var px = i / (n - 1) * w, py = h - 2 - v / max * (h - 6); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.strokeStyle = col; x.lineWidth = 1.6; x.stroke();
    x.lineTo(w, h); x.lineTo(0, h); x.closePath(); var g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, alpha(col, .28)); g.addColorStop(1, alpha(col, 0)); x.fillStyle = g; x.fill();
  }
  function heat(series) {
    var cv = document.getElementById('heat'), w = cv.clientWidth, h = cv.clientHeight, x = cv.getContext('2d');
    cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio; x.scale(devicePixelRatio, devicePixelRatio);
    x.fillStyle = COL.panel2; x.fillRect(0, 0, w, h);
    var cols = ${WINDOW}, rows = ${BUCKETS}, cw = w / cols, rh = h / rows, max = 1;
    series.forEach(function (s) { s.hist.forEach(function (v) { if (v > max) max = v; }); });
    series.forEach(function (s, i) {
      var cx = (cols - series.length + i) * cw;
      s.hist.forEach(function (v, b) {
        if (!v) return; var t = Math.pow(v / max, .45);
        x.fillStyle = b >= ${BUCKETS - 6} ? alpha(COL.bad, .25 + t * .75) : b >= ${BUCKETS - 10} ? alpha(COL.warn, .2 + t * .8) : alpha(COL.cora, .12 + t * .88);
        x.fillRect(cx, h - (b + 1) * rh, cw + .6, rh + .6);
      });
    });
  }
  function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(2) + 'k' : String(Math.round(n)); }
  cora.onData(function (d) {
    var s = d.series, last = s[s.length - 1]; if (!last) return;
    document.getElementById('phase').textContent = d.phase;
    document.getElementById('rps').innerHTML = fmt(last.rps) + '<small>req/s</small>';
    document.getElementById('p95').innerHTML = Math.round(last.p95) + '<small>ms</small>';
    document.getElementById('p99').innerHTML = Math.round(last.p99) + '<small>ms</small>';
    document.getElementById('err').innerHTML = last.err.toFixed(2) + '<small>%</small>';
    document.getElementById('vus').textContent = last.vus;
    document.getElementById('c-p99').classList.toggle('hot', last.p99 > 450);
    document.getElementById('c-err').classList.toggle('hot', last.err > 1);
    var pick = function (k) { return s.map(function (x) { return x[k]; }); };
    spark('s-rps', pick('rps'), COL.cora); spark('s-p95', pick('p95'), COL.warn); spark('s-p99', pick('p99'), COL.bad); spark('s-err', pick('err'), COL.bad); spark('s-vus', pick('vus'), COL.ok);
    if (main) {
      main.data.labels = s.map(function (x) { return x.t; });
      ['rps', 'p50', 'p95', 'p99'].forEach(function (k, i) { main.data.datasets[i].data = pick(k); });
      main.update('none');
    }
    heat(s);
    var top = Math.max.apply(null, d.endpoints.map(function (e) { return e.p95; }));
    document.getElementById('eps').innerHTML = d.endpoints.map(function (e) {
      return '<tr><td class="n">' + e.name + '</td><td class="lat"><b class="' + (e.p95 > 250 ? 'slow' : '') + '" style="width:' + Math.max(4, 100 * e.p95 / top) + '%"></b></td><td class="r">' + Math.round(e.p95) + ' ms</td><td class="r">' + fmt(e.rps) + '/s</td></tr>';
    }).join('');
    var f = document.getElementById('finding');
    if (d.finding) { document.getElementById('f-h').textContent = d.finding.title; document.getElementById('f-p').textContent = d.finding.text; f.classList.add('on'); } else f.classList.remove('on');
  });
</script></body></html>
`;

type Sample = { t: number; rps: number; p50: number; p95: number; p99: number; err: number; vus: number; hist: number[] };

/** One second of the test, `s` seconds in: ramping to 400 users, the indexer's pauses every 30 s. */
export function loadSample(s: number, rnd = Math.random): Sample {
  const vus = Math.round(Math.min(400, 20 + s * 4.5));
  const load = vus / 400;
  const gc = s > 20 && s % 30 >= 27 ? 1 - Math.abs((s % 30) - 28) / 2 : 0;
  const jitter = () => 1 + (rnd() - 0.5) * 0.12;
  const p50 = (28 + 26 * load * load) * jitter() * (1 + gc * 0.6);
  const p95 = (p50 * 2.6 + 30 * load) * jitter() * (1 + gc * 0.8);
  const p99 = p95 * 1.7 * jitter();
  const rps = vus * 5.2 * (1 - gc * 0.28) * jitter();
  const err = Math.max(0, 0.04 + 0.1 * load * load + gc * 2.4 + (rnd() - 0.5) * 0.05);
  // how many requests fell in each latency bucket: around p50, with p95's and p99's tail
  const hist = EDGES.slice(0, -1).map((lo, b) => {
    const mid = Math.sqrt(lo * EDGES[b + 1]);
    const body = Math.exp(-Math.pow(Math.log(mid / p50) / 0.42, 2));
    const tail = 0.08 * Math.exp(-Math.pow(Math.log(mid / p95) / 0.5, 2)) + 0.025 * Math.exp(-Math.pow(Math.log(mid / p99) / 0.45, 2));
    return Math.round(rps * (body + tail) * (0.85 + rnd() * 0.3));
  });
  return { t: s, rps, p50, p95, p99, err, vus, hist };
}

export function loadData(s: number, series: Sample[]): object {
  const last = series[series.length - 1];
  const gcSeen = Math.floor((s - 20) / 30);
  const phase = s < 85 ? `ramping up · ${last.vus} of 400 users` : `holding 400 users · ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s in`;
  const eps = [
    ['GET /search', 1, 0.52],
    ['GET /suggest', 0.45, 0.3],
    ['POST /saved-search', 1.6, 0.1],
    ['GET /export', 3.1, 0.05],
    ['GET /health', 0.12, 0.03],
  ] as const;
  return {
    phase,
    series,
    endpoints: eps.map(([name, k, share]) => ({ name, p95: last.p95 * k, rps: last.rps * share })),
    ...(gcSeen >= 2
      ? { finding: { title: `p99 jumps every 30 s, in step with the indexer's GC (${gcSeen} of ${gcSeen} spikes)`, text: 'Each pause pushes p99 past 750 ms and errors spike to 2.5%. Its heap is at 92%: raising it to 2 GB, or streaming exports, should flatten them.' } }
      : {}),
  };
}

/** Keep it going: a sample a second, its last 90 s in the data. */
export async function loadDashboard(live: { start(sid: string, title: string): { page: string; data: string } }, sid: string, stopped: () => boolean, sleep: (ms: number) => Promise<unknown>): Promise<void> {
  await sleep(3000);
  const f = live.start(sid, 'Search API load test');
  writeFileSync(f.page, LOAD_PAGE);
  const series: Sample[] = [];
  for (let s = 0; !stopped(); s++) {
    series.push(loadSample(s));
    if (series.length > WINDOW) series.shift();
    writeFileSync(f.data, JSON.stringify(loadData(s, series)));
    await new Promise((r) => setTimeout(r, 1000));
  }
}
