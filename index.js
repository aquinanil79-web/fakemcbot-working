'use strict';

const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const MAX_ACTIVE_BOTS = Math.max(1, Number(process.env.MAX_ACTIVE_BOTS || 10));
const CREATE_COOLDOWN_MS = Math.max(0, Number(process.env.CREATE_COOLDOWN_MS || 30000));
const WORKER = require('path').join(__dirname, 'worker.js');
const BASE_CONFIG = require('./settings.json');

app.use(express.json({ limit: '32kb' }));

const bots = new Map();
const recentCreates = new Map();

function safeText(value, max = 120) {
  return String(value ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, max);
}

function makeUsername() {
  for (let i = 0; i < 100; i++) {
    const username = `Bot_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    if (![...bots.values()].every(b => b.username.toLowerCase() !== username.toLowerCase())) return username;
  }
  throw new Error('Could not generate a unique bot username');
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return true;
  if (net.isIP(h) === 4) {
    const [a,b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 0) || a >= 224;
  }
  if (net.isIP(h) === 6) {
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  }
  return false;
}

async function validateTarget(host) {
  host = host.trim();
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error('Enter a valid Minecraft IP or hostname.');
  }
  if (isBlockedHostname(host)) throw new Error('Private/local network targets are not allowed.');

  // Resolve DNS names and reject obvious private/local results.
  if (!net.isIP(host)) {
    let addresses;
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      throw new Error('The hostname could not be resolved.');
    }
    if (!addresses.length || addresses.some(a => isBlockedHostname(a.address))) {
      throw new Error('Private/local network targets are not allowed.');
    }
  }
  return host;
}

function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || 'unknown';
}

function publicBot(bot) {
  return {
    username: bot.username,
    slug: bot.username,
    status: bot.state.status,
    uptime: bot.state.uptime,
    coords: bot.state.coords,
    lastActivity: bot.state.lastActivity,
    reconnectAttempts: bot.state.reconnectAttempts,
    server: bot.server,
    version: bot.version,
    activity: bot.activity.slice(-30),
    createdAt: bot.createdAt
  };
}

function stopBot(bot) {
  if (!bot || bot.stopped) return;
  bot.stopped = true;
  try { bot.child.kill('SIGTERM'); } catch {}
  bots.delete(bot.username);
}

function spawnBot({ host, port, version, username }) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  config.name = username;
  config['bot-account'] = {
    ...(config['bot-account'] || {}),
    username,
    password: '',
    type: 'offline'
  };
  config.server = {
    ...(config.server || {}),
    ip: host,
    port,
    version: version || ''
  };

  // Public workers never reuse the template's credentials, Discord webhook,
  // or automatic chat messages. They only perform the AFK/movement behavior.
  config.utils = config.utils || {};
  config.utils['auto-auth'] = { ...(config.utils['auto-auth'] || {}), enabled: false };
  config.utils['chat-messages'] = { ...(config.utils['chat-messages'] || {}), enabled: false };
  config.discord = { ...(config.discord || {}), enabled: false };
  config.chat = { ...(config.chat || {}), respond: false };

  const bot = {
    username,
    server: `${host}:${port}`,
    version: version || 'auto',
    createdAt: Date.now(),
    stopped: false,
    state: {
      status: 'starting',
      uptime: 0,
      coords: null,
      lastActivity: Date.now(),
      reconnectAttempts: 0
    },
    activity: [{
      type: 'system',
      message: `Starting ${username} for ${host}:${port}`,
      time: Date.now()
    }]
  };

  const child = spawn(process.execPath, [WORKER], {
    cwd: __dirname,
    env: {
      ...process.env,
      BOT_WORKER: '1',
      BOT_CONFIG_JSON: JSON.stringify(config)
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  bot.child = child;

  child.on('message', msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      bot.state = {
        status: msg.status || bot.state.status,
        uptime: Number(msg.uptime || 0),
        coords: msg.coords || null,
        lastActivity: Number(msg.lastActivity || bot.state.lastActivity),
        reconnectAttempts: Number(msg.reconnectAttempts || 0)
      };
      if (msg.activity) {
        bot.activity.push(msg.activity);
        if (bot.activity.length > 100) bot.activity = bot.activity.slice(-100);
      }
    }
  });

  child.stdout.on('data', chunk => {
    const line = String(chunk).trim();
    if (line) {
      console.log(`[${username}] ${line}`);
      if (/Connected|Spawned|Disconnected|Kicked|Error|reconnect/i.test(line)) {
        bot.activity.push({ type: 'log', message: line.slice(0, 300), time: Date.now() });
      }
    }
  });
  child.stderr.on('data', chunk => {
    const line = String(chunk).trim();
    if (line) {
      console.error(`[${username}] ${line}`);
      bot.activity.push({ type: 'error', message: line.slice(0, 300), time: Date.now() });
    }
  });

  child.on('exit', (code, signal) => {
    if (bot.stopped) return;
    bot.state.status = 'crashed';
    bot.activity.push({ type: 'error', message: `Bot process stopped (${signal || `code ${code}`})`, time: Date.now() });
    // Remove it after a short period so the dashboard can show the final state.
    setTimeout(() => bots.delete(username), 5 * 60 * 1000);
  });

  bots.set(username, bot);
  return bot;
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeText(title, 80)}</title>
<style>
:root{color-scheme:dark;--bg:#070b14;--panel:#0f172a;--panel2:#111c31;--line:#22304a;--text:#eef4ff;--muted:#8ea0bc;--accent:#39e6c1;--blue:#61a8ff}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:radial-gradient(circle at 50% -20%,#16314f 0,#070b14 48%);color:var(--text);min-height:100vh}
a{color:inherit;text-decoration:none}.wrap{width:min(1050px,calc(100% - 28px));margin:auto;padding:38px 0 60px}
.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}.brand{font-weight:800;letter-spacing:.04em}.brand span{color:var(--accent)}
.card{background:rgba(15,23,42,.88);border:1px solid var(--line);border-radius:22px;padding:24px;box-shadow:0 18px 50px #0006;backdrop-filter:blur(10px)}
.hero{padding:36px}.eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.hero h1{font-size:clamp(34px,6vw,62px);line-height:1;margin:12px 0}.hero p{color:var(--muted);font-size:17px;max-width:700px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:18px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}.stat{background:var(--panel2);border:1px solid var(--line);border-radius:16px;padding:18px}.label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}.value{font-size:20px;font-weight:750;margin-top:7px;overflow:hidden;text-overflow:ellipsis}.online{color:#52e39d}.offline{color:#ff7777}.starting{color:#ffd166}
form{display:grid;gap:13px}.row{display:grid;grid-template-columns:1fr 150px;gap:12px}label{font-size:12px;color:var(--muted)}input{width:100%;margin-top:6px;padding:14px 15px;border-radius:12px;border:1px solid var(--line);background:#08101f;color:var(--text);font-size:15px;outline:none}input:focus{border-color:var(--accent)}button{border:0;border-radius:12px;padding:14px 18px;background:var(--accent);color:#05120f;font-weight:800;font-size:15px;cursor:pointer}button:hover{filter:brightness(1.08)}
.notice{display:none;margin-top:14px;padding:13px;border-radius:12px;background:#33191f;border:1px solid #6e303b;color:#ffb8c0}.url{margin-top:16px;padding:14px;border-radius:12px;background:#071c1a;border:1px solid #155e55;display:none}.url code{color:var(--accent)}
.activity{margin-top:18px}.event{padding:12px 0;border-bottom:1px solid #1b2940}.event:last-child{border-bottom:0}.event small{color:var(--muted);display:block;margin-bottom:3px}.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(max-width:720px){.grid,.stats{grid-template-columns:1fr 1fr}.row{grid-template-columns:1fr}.hero{padding:25px}}
</style></head><body><main class="wrap">${body}</main></body></html>`;
}

app.get('/', (req, res) => {
  const active = [...bots.values()].filter(b => !b.stopped).length;
  res.send(pageShell('Minecraft Bot Hosting', `
    <div class="nav"><div class="brand">MC<span>BOT</span> PUBLIC</div><div class="muted">${active}/${MAX_ACTIVE_BOTS} active</div></div>
    <section class="card hero">
      <div class="eyebrow">Public Minecraft Bot</div>
      <h1>Keep a bot online.</h1>
      <p>Enter a public Minecraft server address and port. A unique offline-mode bot name is generated for you, and you get a private dashboard URL for that bot.</p>
      <form id="create">
        <div class="row">
          <div><label>Server IP / hostname<input id="host" required maxlength="253" placeholder="play.example.net"></label></div>
          <div><label>Port<input id="port" required type="number" min="1" max="65535" value="25565"></label></div>
        </div>
        <div><label>Version <span class="muted">(optional; leave blank for auto-detect)</span><input id="version" maxlength="20" placeholder="1.21.11"></label></div>
        <button>Create unique bot</button>
      </form>
      <div id="notice" class="notice"></div>
      <div id="url" class="url">Dashboard: <a id="link"><code></code></a></div>
    </section>
    <div class="grid">
      <div class="card"><div class="label">How it works</div><p class="muted">Each request launches its own worker process and Minecraft account name. Dashboards are available at <span class="mono">/Bot_XXXX</span>.</p></div>
      <div class="card"><div class="label">Limits</div><p class="muted">Public creation is rate-limited and active bots are capped to protect the host and Minecraft servers.</p></div>
    </div>
<script>
const form=document.getElementById('create'),notice=document.getElementById('notice'),box=document.getElementById('url'),link=document.getElementById('link');
form.addEventListener('submit',async e=>{
 e.preventDefault(); notice.style.display='none'; box.style.display='none';
 const payload={host:document.getElementById('host').value,port:document.getElementById('port').value,version:document.getElementById('version').value};
 try{
  const r=await fetch('/api/bots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not create bot');
  const u=new URL(d.dashboard,location.href).href; link.href=u; link.querySelector('code').textContent=u; box.style.display='block';
  setTimeout(()=>location.href=d.dashboard,1200);
 }catch(err){notice.textContent=err.message;notice.style.display='block'}
});
</script>`));
});

app.post('/api/bots', async (req, res) => {
  try {
    if (bots.size >= MAX_ACTIVE_BOTS) return res.status(429).json({ error: 'The public bot limit is currently full. Try again later.' });
    const key = clientKey(req);
    const last = recentCreates.get(key) || 0;
    if (Date.now() - last < CREATE_COOLDOWN_MS) {
      const wait = Math.ceil((CREATE_COOLDOWN_MS - (Date.now() - last)) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before creating another bot.` });
    }

    const host = await validateTarget(String(req.body?.host || ''));
    const port = validPort(req.body?.port);
    if (!port) return res.status(400).json({ error: 'Port must be between 1 and 65535.' });

    let version = safeText(req.body?.version, 20);
    if (version && !/^[0-9]+(?:\\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
      return res.status(400).json({ error: 'Invalid Minecraft version.' });
    }

    const username = makeUsername();
    recentCreates.set(key, Date.now());
    const bot = spawnBot({ host, port, version, username });

    res.status(201).json({
      username,
      dashboard: `/${encodeURIComponent(username)}`,
      server: bot.server
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Invalid request.' });
  }
});

app.get('/:username', (req, res, next) => {
  if (req.params.username === 'api' || req.params.username === 'health') return next();
  const username = safeText(req.params.username, 16);
  const bot = bots.get(username);
  if (!bot) return res.status(404).send(pageShell('Bot not found', `<div class="nav"><a class="brand" href="/">MC<span>BOT</span> PUBLIC</a></div><div class="card"><h1>Bot not found</h1><p class="muted">This dashboard does not exist or the bot has expired.</p><a href="/" style="color:var(--accent)">Create a bot →</a></div>`));

  res.send(pageShell(`${bot.username} Dashboard`, `
    <div class="nav"><a class="brand" href="/">MC<span>BOT</span> PUBLIC</a><div class="mono">${safeText(bot.username)}</div></div>
    <section class="card">
      <div class="eyebrow">Bot Dashboard</div>
      <h1>${safeText(bot.username)}</h1>
      <p class="muted">Server: <span class="mono">${safeText(bot.server)}</span></p>
      <div class="stats">
        <div class="stat"><div class="label">Status</div><div id="status" class="value starting">Starting</div></div>
        <div class="stat"><div class="label">Uptime</div><div id="uptime" class="value">0s</div></div>
        <div class="stat"><div class="label">Position</div><div id="coords" class="value">—</div></div>
        <div class="stat"><div class="label">Reconnects</div><div id="reconnects" class="value">0</div></div>
      </div>
      <div class="activity"><div class="label">Recent activity</div><div id="events" class="muted">Waiting for activity…</div></div>
    </section>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=s=>{s=Math.max(0,Number(s)||0);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+'h ':'')+(m?m+'m ':'')+x+'s'};
async function update(){
 try{
  const r=await fetch('/api/bots/${encodeURIComponent(bot.username)}'); if(!r.ok) throw new Error();
  const d=await r.json(); const st=document.getElementById('status'); st.textContent=d.status; st.className='value '+(d.status==='connected'?'online':d.status==='crashed'?'offline':'starting');
  document.getElementById('uptime').textContent=fmt(d.uptime);
  document.getElementById('coords').textContent=d.coords?(Math.floor(d.coords.x)+', '+Math.floor(d.coords.y)+', '+Math.floor(d.coords.z)):'—';
  document.getElementById('reconnects').textContent=d.reconnectAttempts;
  document.getElementById('events').innerHTML=(d.activity||[]).slice().reverse().map(e=>'<div class="event"><small>'+new Date(e.time).toLocaleString()+'</small>'+esc(e.message||e.type)+'</div>').join('')||'No activity yet.';
 }catch(e){document.getElementById('status').textContent='Unavailable';document.getElementById('status').className='value offline'}
}
setInterval(update,2000);update();
</script>`));
});

app.get('/api/bots/:username', (req, res) => {
  const bot = bots.get(safeText(req.params.username, 16));
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json(publicBot(bot));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeBots: [...bots.values()].filter(b => !b.stopped).length,
    maxActiveBots: MAX_ACTIVE_BOTS
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Public Bot Service] Listening on ${PORT}`);
  console.log(`[Public Bot Service] Max active bots: ${MAX_ACTIVE_BOTS}`);
});

process.on('SIGTERM', () => {
  console.log('[System] Shutting down bot workers...');
  for (const bot of bots.values()) {
    try { bot.child.kill('SIGTERM'); } catch {}
  }
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => process.emit('SIGTERM'));
