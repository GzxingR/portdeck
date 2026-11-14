// PortDeck — 本机端口总控台
// 单文件 Node 服务：扫描监听端口 + 多层自动识别 + 提供 Web UI
// 零依赖，只用 Node 内置模块。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORTDECK_PORT || 4999);
const HOST = process.env.PORTDECK_HOST || '127.0.0.1';
// 本机配置优先读 *.local.json（不进 Git）；仓库里的 ports.json / rules.json 是通用示例。
const META_FILE = path.join(__dirname,
  fs.existsSync(path.join(__dirname, 'ports.local.json')) ? 'ports.local.json' : 'ports.json');
const RULES_FILE = path.join(__dirname, 'rules.json');
const RULES_LOCAL_FILE = path.join(__dirname, 'rules.local.json');
const DEFAULT_APP_NAME = 'PortDeck';
const CATS = ['模型', '代理', '工具', '系统', '应用', '其他'];

/* ---------------------------------------------------------------- 元数据 */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ports.json 同时保存控制台名称（appName）和手动标注（ports）。
function loadMetaFile() {
  const j = readJson(META_FILE, { ports: [] });
  const name = typeof j.appName === 'string' ? j.appName.trim() : '';
  return {
    version: Number(j.version) || 1,
    appName: name.slice(0, 40) || DEFAULT_APP_NAME,
    ports: Array.isArray(j.ports) ? j.ports : [],
  };
}

function loadMeta() {
  const map = new Map();
  for (const p of loadMetaFile().ports) map.set(Number(p.port), p);
  return map;
}

// 所有写操作串行化，避免两个请求同时读写 ports.json 时互相覆盖。
let writeChain = Promise.resolve();
function saveMeta(mutator) {
  writeChain = writeChain.catch(() => {}).then(() => {
    const data = loadMetaFile();
    const result = mutator(data);
    const tmp = META_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, META_FILE);   // 原子替换，写一半不会留下坏文件
    return result;
  });
  return writeChain;
}

// 校验并规范化前端提交的服务数据；不合法直接抛错，由路由转成 400。
function normalizeService(input, base = {}) {
  const out = { ...base };
  if ('port' in input) {
    const n = Number(input.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口号必须是 1–65535 的整数');
    out.port = n;
  }
  for (const k of ['name', 'cat', 'note', 'url']) {
    if (k in input) out[k] = String(input[k] ?? '').trim();
  }
  if ('showWhenOffline' in input) out.showWhenOffline = Boolean(input.showWhenOffline);

  if (!String(out.name || '').trim()) throw new Error('服务名称不能为空');
  out.name = String(out.name).slice(0, 80);
  out.cat = CATS.includes(out.cat) ? out.cat : '其他';
  out.note = String(out.note || '').slice(0, 300);
  out.url = String(out.url || '').slice(0, 500);
  if (out.url && !/^https?:\/\//i.test(out.url)) throw new Error('打开地址必须以 http:// 或 https:// 开头');
  if (!out.url) delete out.url;
  if (!out.note) delete out.note;
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      body += c;
      if (body.length > 16384) { done = true; reject(new Error('请求体过大')); }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function loadRules() {
  const base = readJson(RULES_FILE, {});
  const extra = readJson(RULES_LOCAL_FILE, {});
  const mergeArray = (a, b) => [...(b || []), ...(a || [])];
  return {
    ...base,
    ...extra,
    processRules: mergeArray(base.processRules, extra.processRules),
    httpFingerprints: mergeArray(base.httpFingerprints, extra.httpFingerprints),
    bannerFingerprints: mergeArray(base.bannerFingerprints, extra.bannerFingerprints),
    portRules: mergeArray(base.portRules, extra.portRules),
    knownPorts: { ...(base.knownPorts || {}), ...(extra.knownPorts || {}) },
    serviceNameMap: { ...(base.serviceNameMap || {}), ...(extra.serviceNameMap || {}) },
  };
}

/* ---------------------------------------------------------------- 规则匹配 */

function cmdMatches(rule, cmd) {
  if (!rule.match) return false;
  if (rule.type === 'regex') {
    try { return new RegExp(rule.match, 'i').test(cmd || ''); } catch { return false; }
  }
  return String(cmd || '').toLowerCase().includes(String(rule.match).toLowerCase());
}

function procMatches(rule, proc) {
  if (!rule.match) return false;
  const p = String(proc || '').toLowerCase();
  const m = String(rule.match).toLowerCase();
  // 进程名按「去掉 .exe 后完全相等」或「包含」匹配，避免 "go" 命中 "google"
  const base = p.replace(/\.exe$/, '');
  if (rule.type === 'regex') {
    try { return new RegExp(rule.match, 'i').test(proc || ''); } catch { return false; }
  }
  return base === m || p === m || base.startsWith(m);
}

/* ---------------------------------------------------------------- 采集 */

// 一次 PowerShell 调用拿全：端口 + 进程 + 版本信息 + 服务名
function scanPorts() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ error: 'only Windows is supported by the built-in collector', ports: [] });
    }
    const ps = `
$ErrorActionPreference='SilentlyContinue'
$out = @()

# 端口用 netstat 拿：实测 59ms，而 Get-NetTCPConnection 要 2100ms（WMI 开销）。
$conns = @()
$ns = netstat -ano | Select-String 'LISTENING'
foreach ($l in $ns) {
  $f = ($l.Line -split '\\s+') | Where-Object { $_ }
  if ($f.Count -lt 5) { continue }
  $local = $f[1]
  $idx = $local.LastIndexOf(':')
  if ($idx -lt 1) { continue }
  $addr = $local.Substring(0, $idx)
  if ($addr -notin @('0.0.0.0','::','127.0.0.1','[::1]','[::]')) { continue }
  $conns += [pscustomobject]@{
    LocalPort = [int]$local.Substring($idx + 1)
    LocalAddress = $addr
    OwningProcess = [int]$f[-1]
  }
}

# 一次性取全部进程和服务并建索引。
# 逐个端口 Get-CimInstance 会退化成 N 次 WMI 往返，实测 59 个端口要 37 秒。
$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
$svcs = @{}
Get-CimInstance Win32_Service | ForEach-Object { if ($_.ProcessId) { $svcs[[int]$_.ProcessId] = $_ } }

$seen = @{}
foreach ($c in $conns) {
  $k = "$($c.LocalPort)|$($c.OwningProcess)"
  if ($seen.ContainsKey($k)) { continue }
  $seen[$k] = 1
  $pid2 = [int]$c.OwningProcess
  $p = $procs[$pid2]
  $exe = if ($p -and $p.ExecutablePath) { $p.ExecutablePath } else { '' }
  $prod = ''; $desc = ''; $comp = ''
  if ($exe -and (Test-Path $exe)) {
    $vi = (Get-Item $exe).VersionInfo
    $prod = $vi.ProductName; $desc = $vi.FileDescription; $comp = $vi.CompanyName
  }
  $svc = $svcs[$pid2]
  $out += [pscustomobject]@{
    port = [int]$c.LocalPort
    addr = $c.LocalAddress
    pid  = $pid2
    proc = if ($p) { $p.Name } else { '' }
    cmd  = if ($p -and $p.CommandLine) { $p.CommandLine } else { '' }
    exe  = $exe
    prod = $prod
    desc = $desc
    comp = $comp
    svc  = if ($svc) { $svc.Name } else { '' }
    svcDisp = if ($svc) { $svc.DisplayName } else { '' }
  }
}
$out | ConvertTo-Json -Compress -Depth 3
`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 35000 },
      (err, stdout) => {
        if (err) return resolve({ error: String(err.message || err), ports: [] });
        try {
          let j = JSON.parse(stdout.trim() || '[]');
          if (!Array.isArray(j)) j = [j];
          resolve({ ports: j });
        } catch (e) {
          resolve({ error: 'parse: ' + e.message, ports: [] });
        }
      });
  });
}

/* ---------------------------------------------------------------- 探测 */

// HTTP 探测：抓状态码 + 标题 + Server / X-Powered-By 头
function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 800,
        headers: { 'User-Agent': 'PortDeck/1.1' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 60000) body += c; });
        res.on('end', () => {
          const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          resolve({
            http: true,
            status: res.statusCode,
            title: m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 90) : '',
            server: res.headers['server'] || '',
            poweredBy: res.headers['x-powered-by'] || '',
            contentType: res.headers['content-type'] || '',
          });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ http: false }); });
    req.on('error', () => resolve({ http: false }));
    req.end();
  });
}

// TCP banner 探测：只对非 HTTP 端口做，读第一段字节。
// 超时压到 400ms —— 本地回环握手是毫秒级，等不到 banner 就是没有，
// 长超时只会让整页刷新卡住（59 个端口串行等 1.4s 就是 30 秒）。
function probeBanner(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(val);
    };
    sock.setTimeout(400);
    sock.on('connect', () => {
      // 有些服务需要客户端先说话，发个换行探一下
      try { sock.write('\r\n'); } catch {}
    });
    sock.on('data', (buf) => {
      const s = buf.toString('latin1').replace(/[^\x20-\x7E\r\n]/g, '.').trim();
      finish(s.slice(0, 120));
    });
    sock.on('timeout', () => finish(''));
    sock.on('error', () => finish(''));
    sock.connect(port, '127.0.0.1');
    setTimeout(() => finish(''), 500);
  });
}

// 并发池：限制同时在跑的探测数，避免 60 个端口同时开 socket 把系统压住
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------------------------------------------- 识别 */

// 精确度从高到低：先认「这是什么程序」，再认「这是什么端口」。
// 端口区间规则放最后，因为它最粗（3000-3999 会把 3425 网关也吞掉）。
function identify(p, rules, httpInfo, banner) {
  // 1) 命令行关键字（最精确：能看到具体是哪个服务）
  for (const r of rules.processRules || []) {
    if (r.field === 'cmd' && cmdMatches(r, p.cmd)) {
      return { name: r.name, cat: r.cat, note: r.note, src: 'cmd-rule' };
    }
  }
  // 2) 进程名
  for (const r of rules.processRules || []) {
    if ((r.field || 'proc') === 'proc' && procMatches(r, p.proc)) {
      return { name: r.name, cat: r.cat, note: r.note, src: 'proc-rule' };
    }
  }
  // 3) HTTP 头指纹（能区分 Express / FastAPI / 自建网关这类）
  if (httpInfo && httpInfo.http) {
    const hdrs = { server: httpInfo.server || '', 'x-powered-by': httpInfo.poweredBy || '' };
    for (const fp of rules.httpFingerprints || []) {
      const val = String(hdrs[fp.header] || '').toLowerCase();
      if (val && val.includes(String(fp.match).toLowerCase())) {
        return { name: fp.name, cat: fp.cat, note: fp.note, src: 'http-header' };
      }
    }
  }
  // 4) banner 指纹
  if (banner) {
    for (const fp of rules.bannerFingerprints || []) {
      if (banner.toLowerCase().includes(String(fp.match).toLowerCase())) {
        return { name: fp.name, cat: fp.cat, note: fp.note, src: 'banner' };
      }
    }
  }
  // 5) 已知端口库（22=SSH、3306=MySQL 这种标准端口）
  const kp = (rules.knownPorts || {})[String(p.port)];
  if (kp) {
    return { name: kp.name, cat: kp.cat, note: kp.note, src: 'known-port' };
  }
  // 6) Windows 服务名
  if (p.svc && rules.serviceNameMap && rules.serviceNameMap[p.svc]) {
    const s = rules.serviceNameMap[p.svc];
    return { name: s.name, cat: s.cat, note: s.note || p.svcDisp, src: 'service' };
  }
  // 7) 可执行文件元数据（ProductName / FileDescription）
  const meta = (p.prod || p.desc || '').trim();
  if (meta && !/^Microsoft. Windows. Operating System$/i.test(meta)) {
    return {
      name: meta.length > 40 ? meta.slice(0, 40) : meta,
      cat: p.comp && /netease|tencent|kingsoft|alibaba|bytedance|microsoft/i.test(p.comp) ? '应用' : '工具',
      note: p.comp ? `${p.comp}${p.desc && p.desc !== meta ? ' · ' + p.desc : ''}` : p.desc,
      src: 'exe-meta',
    };
  }
  // 8) 端口区间（最粗，只做兜底）
  for (const r of rules.portRules || []) {
    const [lo, hi] = r.range || [];
    if (p.port >= lo && p.port <= hi) {
      return { name: r.name, cat: r.cat, note: r.note, src: 'port-rule' };
    }
  }
  // 9) 兜底：服务显示名
  if (p.svcDisp) {
    return { name: p.svcDisp, cat: '系统', note: p.svc || '', src: 'service-disp' };
  }
  return null;
}

/* ---------------------------------------------------------------- 状态 */

async function buildState() {
  const metaFile = loadMetaFile();
  const meta = new Map();
  for (const p of metaFile.ports) meta.set(Number(p.port), p);
  const rules = loadRules();
  const { ports, error } = await scanPorts();

  // 先并发探测（HTTP + banner），再识别。
  // 走并发池而不是 Promise.all：60 个端口同时开 socket 会压住系统，
  // 而且 banner 探测有超时，串行下来整页要等半分钟。
  const enriched = await mapLimit(ports, 32, async (p) => {
    const manual = meta.get(p.port);
    const httpInfo = await probeHttp(p.port);
    let banner = '';
    if (!httpInfo.http) banner = await probeBanner(p.port);
    return { p, manual, httpInfo, banner };
  });

  const merged = enriched.map(({ p, manual, httpInfo, banner }) => {
    const auto = manual ? null : identify(p, rules, httpInfo, banner);
    const src = manual ? 'manual' : (auto ? auto.src : 'unknown');
    return {
      port: p.port,
      addr: p.addr,
      pid: p.pid,
      proc: p.proc,
      cmd: (p.cmd || '').slice(0, 400),
      exe: p.exe || '',
      product: p.prod || '',
      company: p.comp || '',
      service: p.svc || '',
      serviceDisplay: p.svcDisp || '',
      name: manual?.name || auto?.name || p.proc || '未知',
      cat: manual?.cat || auto?.cat || '其他',
      note: manual?.note || auto?.note || '',
      url: manual?.url || (httpInfo.http ? `http://127.0.0.1:${p.port}/` : ''),
      known: Boolean(manual || auto),
      src,
      showWhenOffline: Boolean(manual?.showWhenOffline),
      http: httpInfo.http,
      status: httpInfo.status || 0,
      title: httpInfo.title || '',
      server: httpInfo.server || '',
      poweredBy: httpInfo.poweredBy || '',
      contentType: httpInfo.contentType || '',
      banner: banner || '',
    };
  });

  // 手动添加、但当前没在监听的服务：标为「未运行」仍然显示在列表里，
  // 方便先把服务登记好、之后启动；默认不显示，可在添加时勾选。
  const listening = new Set(merged.map((p) => p.port));
  for (const [port, m] of meta) {
    if (listening.has(port) || !m.showWhenOffline) continue;
    merged.push({
      port, addr: '—', pid: 0, proc: '', cmd: '', exe: '', product: '', company: '',
      service: '', serviceDisplay: '',
      name: m.name || '未知', cat: m.cat || '其他', note: m.note || '', url: m.url || '',
      known: true, src: 'manual', offline: true,
      showWhenOffline: Boolean(m.showWhenOffline),
      http: false, status: 0,
      title: '', server: '', poweredBy: '', contentType: '', banner: '',
    });
  }

  merged.sort((a, b) => a.port - b.port);
  return {
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    appName: metaFile.appName,
    error: error || null,
    ports: merged,
  };
}

/* ---------------------------------------------------------------- 服务 */

const HTML_PATH = path.join(__dirname, 'ui.html');

// 控制台名称是配置，不写死在 HTML 里。每次请求现读，改完名马上生效。
function renderHtml() {
  const appName = loadMetaFile().appName;
  const safe = JSON.stringify(appName)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const html = fs.readFileSync(HTML_PATH, 'utf8')
    .replace('</head>', `<script>window.PORTDECK_APP_NAME=${safe};</script>\n</head>`);
  // 标题里的用户文本走 HTML 转义；script 里的 JSON 已单独处理尖括号。
  return html.replace(/<title>PortDeck · 本机端口总控台<\/title>/,
    `<title>${appName.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))} · 本机端口总控台</title>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 本地写接口：所有写操作都落到 ports.json，写入后前端重新拉 /api/ports。
  if (url.pathname === '/api/services' || url.pathname.startsWith('/api/services/') ||
      url.pathname === '/api/settings') {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return sendJson(res, 403, { error: '禁止跨站写入' });
    }
    try {
      if (url.pathname === '/api/services' && req.method === 'GET') {
        const j = loadMetaFile();
        return sendJson(res, 200, { appName: j.appName, services: j.ports });
      }

      if (url.pathname === '/api/services' && req.method === 'POST') {
        const input = await readBody(req);
        let created;
        await saveMeta((j) => {
          const service = normalizeService(input);
          if (j.ports.some((p) => Number(p.port) === service.port)) {
            const e = new Error(`端口 ${service.port} 已有标注，请直接编辑`);
            e.status = 409;
            throw e;
          }
          j.ports.push(service);
          j.ports.sort((a, b) => a.port - b.port);
          created = service;
        });
        return sendJson(res, 201, { ok: true, service: created });
      }

      if (url.pathname === '/api/settings' && req.method === 'PUT') {
        const input = await readBody(req);
        const name = String(input.appName ?? '').trim();
        if (!name || name.length > 40) throw new Error('名称长度必须是 1–40 个字符');
        await saveMeta((j) => { j.appName = name; });
        return sendJson(res, 200, { ok: true, appName: name });
      }

      const m = url.pathname.match(/^\/api\/services\/(\d{1,5})$/);
      if (m && (req.method === 'PUT' || req.method === 'PATCH')) {
        const oldPort = Number(m[1]);
        const input = await readBody(req);
        let updated;
        await saveMeta((j) => {
          const i = j.ports.findIndex((p) => Number(p.port) === oldPort);
          // 自动识别 / 未识别的端口没有手动标注，保存时直接创建一条（upsert）。
          // 这样任何端口都能点「标注」改名称、分类、说明。
          const base = i >= 0 ? j.ports[i] : {};
          const service = normalizeService({ port: oldPort, ...input }, base);
          if (service.port !== oldPort && j.ports.some((p, k) => k !== i && Number(p.port) === service.port)) {
            const e = new Error(`端口 ${service.port} 已有标注`); e.status = 409; throw e;
          }
          if (i >= 0) j.ports[i] = service;
          else j.ports.push(service);
          j.ports.sort((a, b) => a.port - b.port);
          updated = service;
        });
        return sendJson(res, 200, { ok: true, service: updated });
      }

      if (m && req.method === 'DELETE') {
        const port = Number(m[1]);
        await saveMeta((j) => {
          const before = j.ports.length;
          j.ports = j.ports.filter((p) => Number(p.port) !== port);
          if (j.ports.length === before) {
            const e = new Error(`端口 ${port} 没有手动标注`); e.status = 404; throw e;
          }
        });
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 405, { error: '不支持的请求方法' });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message || String(e) });
    }
  }

  if (url.pathname === '/api/ports') {
    try {
      const state = await buildState();
      sendJson(res, 200, state);
    } catch (e) {
      sendJson(res, 500, { error: String(e), ports: [] });
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderHtml());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('UI 加载失败: ' + e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`PortDeck on http://${HOST}:${PORT}`);
});
