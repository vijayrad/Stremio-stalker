#!/usr/bin/env node
// Stremio ⇄ Stalker/Ministra IPTV Add-on
// ESM • Web UI • Redirect handling • HTTPS-ready
// Request style (matches your sample):
//   GET /stalker_portal/server/load.php?type=stb&action=handshake&token=&prehash=...&JsHttpRequest=1-xml
// Headers we send:
//   Accept: */*
//   User-Agent: StalkerTV-Free/40304.13 CFNetwork/3860.200.31 Darwin/25.1.0
//   Authorization: Bearer <token> (blank for handshake)
//   Accept-Language: en-IN,en-GB;q=0.9,en;q=0.8
//   Accept-Encoding: gzip, deflate
//   Cookie: mac=<MAC>; stb_lang=en_IN; timezone=Asia/Kolkata; __cfduid=<persisted>

import sdk from 'stremio-addon-sdk'
import axios from 'axios'
import express from 'express'
import fs from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const { addonBuilder, getRouter } = sdk

/* ───────────────────────── Manifest ───────────────────────── */
const manifest = {
  id: 'org.stalker.iptv',
  version: '1.9.0',
  name: 'Stalker IPTV (GET portal.php headers match)',
  description: 'Stremio add-on for Stalker/Ministra IPTV. Uses GET with StalkerTV-like headers & cookies.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'stalker_live', name: 'Live TV (Stalker)' }],
  idPrefixes: ['stalker:']
}

const builder = new addonBuilder(manifest)

console.log('🧩 Add-on manifest loaded:')
console.log('  id:', manifest.id)
console.log('  idPrefixes:', manifest.idPrefixes)
console.log('  resources:', manifest.resources)
console.log('  catalogs:', manifest.catalogs.map(c => c.id).join(', '))
console.log('--------------------------------------------------------')

/* ───────────────────────── Config ───────────────────────── */
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONFIG_PATH = path.join(__dirname, 'config.json')

let userConfig = {
  portal_url: '',              // normalized to .../stalker_portal/server/load.php
  mac: '',
  stb_lang: 'en_IN',
  timezone: 'Asia/Kolkata',
  user_agent: 'StalkerTV-Free/40304.13 CFNetwork/3860.200.31 Darwin/25.1.0',
  accept_language: 'en-IN,en-GB;q=0.9,en;q=0.8',
  prehash: '',                 // optional
  __cfduid: ''                 // persisted random
}

if (fs.existsSync(CONFIG_PATH)) {
  try { userConfig = { ...userConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } } catch {}
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2)) }
if (!userConfig.__cfduid) { userConfig.__cfduid = crypto.randomBytes(16).toString('hex'); try { saveConfig() } catch {} }

/* ───────────────────────── Helpers ───────────────────────── */
const tokenCache = new Map() // key: base|mac → { token, ts }

function ensureLoadPhp(anyUrl) {
  const raw = (anyUrl || '').trim()
  if (!raw) return ''
  let base = raw.includes('://') ? raw : `http://${raw}`
  const u = new URL(base)
  let p = u.pathname.replace(/\/+$/, '')
  if (p.endsWith('/server/load.php')) {
    // ok
  } else if (p.includes('/stalker_portal')) {
    p = p.replace(/\/+$/, '') + '/server/load.php'
  } else {
    p = '/server/load.php'
    //p = '/portal.php'
  }
  u.pathname = p
  u.search = ''
  return u.toString().replace(/\/+$/, '')
}

function resolveRedirectToLoadPhp(currentBase, location) {
  const resolved = new URL(location, currentBase).toString()
  return ensureLoadPhp(resolved)
}

function cacheKey(base, mac) { return `${base}|${mac}`.toLowerCase() }

function buildCookie(mac) {
  const parts = [
    `mac=${mac}`,
    `stb_lang=${userConfig.stb_lang || 'en_IN'}`,
    `timezone=${userConfig.timezone || 'Asia/Kolkata'}`,
    `__cfduid=${userConfig.__cfduid}`
  ]
  return parts.join('; ')
}

function extractToken(hs) {
  return hs?.token
      || hs?.js?.token
      || hs?.data?.token
      || hs?.js?.data?.token
      || null
}

/* ───────────────────────── Core GET (with redirects) ───────────────────────── */
async function stalkerGet({ base, mac, action, token, params = {}, includeTokenParam = true, includePrehashParam = true }) {
  const q = new URLSearchParams()
  q.set('type', 'stb')
  q.set('action', action)
  if (includeTokenParam) q.set('token', token || '')
  if (includePrehashParam && userConfig.prehash) q.set('prehash', userConfig.prehash)
  q.set('JsHttpRequest', '1-xml')
  for (const [k, v] of Object.entries(params || {})) if (v != null) q.set(k, String(v))

  const loadPhp = ensureLoadPhp(base)
  const url = `${loadPhp}?${q.toString()}`
  const res = await axios.get(url, {
    timeout: 12000,
    decompress: true,
    headers: {
      'Accept': '*/*',
      'User-Agent': userConfig.user_agent,
      'Authorization': token ? `Bearer ${token}` : '',
      'Accept-Language': userConfig.accept_language,
      'Accept-Encoding': 'gzip, deflate',
      'Cookie': buildCookie(mac)
    },
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400
  })

  if (res.status >= 300 && res.status < 400 && res.headers?.location) {
    return {
      redirectTo: resolveRedirectToLoadPhp(loadPhp, res.headers.location),
      permanent: (res.status === 301 || res.status === 308)
    }
  }
  return { data: res.data }
}

/* ───────────────────────── Core GET (with redirects) ───────────────────────── */
async function stalkerGet1({ base, mac, action, token, params = {}, includeTokenParam = true, includePrehashParam = true }) {
  const q = new URLSearchParams()
  q.set('type', 'itv')
  q.set('action', action)
  if (includeTokenParam) q.set('token', token || '')
  if (includePrehashParam && userConfig.prehash) q.set('prehash', userConfig.prehash)
  q.set('JsHttpRequest', '1-xml')
  for (const [k, v] of Object.entries(params || {})) if (v != null) q.set(k, String(v))

  const loadPhp = ensureLoadPhp(base)
  const url = `${loadPhp}?${q.toString()}`
  const res = await axios.get(url, {
    timeout: 12000,
    decompress: true,
    headers: {
      'Accept': '*/*',
      'User-Agent': userConfig.user_agent,
      'Authorization': token ? `Bearer ${token}` : '',
      'Accept-Language': userConfig.accept_language,
      'Accept-Encoding': 'gzip, deflate',
      'Cookie': buildCookie(mac)
    },
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400
  })

  if (res.status >= 300 && res.status < 400 && res.headers?.location) {
    return {
      redirectTo: resolveRedirectToLoadPhp(loadPhp, res.headers.location),
      permanent: (res.status === 301 || res.status === 308)
    }
  }

  return { data: res.data }
}

async function doRequest({ portalUrl, mac, action, token, params, includeTokenParam = true, includePrehashParam = true }) {
  let base = ensureLoadPhp(portalUrl)
  if (!base) throw new Error('Invalid portal URL')

  for (let hop = 0; hop < 3; hop++) {
    const r = await stalkerGet({ base, mac, action, token, params, includeTokenParam, includePrehashParam })
    if (r.redirectTo) {
      const old = base
      base = ensureLoadPhp(r.redirectTo)
      tokenCache.delete(cacheKey(old, mac))
      if (r.permanent) {
        userConfig.portal_url = base
        try { saveConfig() } catch {}
        console.log(`🔁 Permanent redirect: ${old} → ${base}`)
      } else {
        console.log(`↪️ Temporary redirect: ${old} → ${base}`)
      }
      continue
    }
    return r.data
  }
  throw new Error('Too many redirects contacting portal')
}


async function doRequest1({ portalUrl, mac, action, token, params, includeTokenParam = true, includePrehashParam = true }) {
  let base = ensureLoadPhp(portalUrl)
  if (!base) throw new Error('Invalid portal URL')

  for (let hop = 0; hop < 3; hop++) {
    const r = await stalkerGet1({ base, mac, action, token, params, includeTokenParam, includePrehashParam })
    if (r.redirectTo) {
      const old = base
      base = ensureLoadPhp(r.redirectTo)
      tokenCache.delete(cacheKey(old, mac))
      if (r.permanent) {
        userConfig.portal_url = base
        try { saveConfig() } catch {}
        console.log(`🔁 Permanent redirect: ${old} → ${base}`)
      } else {
        console.log(`↪️ Temporary redirect: ${old} → ${base}`)
      }
      continue
    }
    return r.data
  }
  throw new Error('Too many redirects contacting portal')
}
/* ───────────────────────── Stalker API wrappers ───────────────────────── */
async function handshake(baseUrl, mac) {
  return await doRequest({
    portalUrl: baseUrl, mac, action: 'handshake',
    token: '', params: {}, includeTokenParam: true, includePrehashParam: true
  })
}
async function getAllChannels(baseUrl, mac, token) {
  return await doRequest1({
    portalUrl: baseUrl, mac, action: 'get_all_channels',
    token, params: {}, includeTokenParam: false, includePrehashParam: false
  })
}
async function createLink(baseUrl, mac, token, cmd) {
  return await doRequest({
    portalUrl: baseUrl, mac, action: 'create_link',
    token, params: { cmd }, includeTokenParam: true, includePrehashParam: false
  })
}
async function getTokenFor(baseUrl, mac) {
  const base = ensureLoadPhp(baseUrl)
  const k = cacheKey(base, mac)
  const cached = tokenCache.get(k)
  if (cached && (Date.now() - cached.ts) < 20 * 60 * 1000 && cached.token) return cached.token
  const hs = await handshake(base, mac)
  const token = extractToken(hs)
  console.log(`Printing the variables ${hs},${token}`);
  if (!token) throw new Error(`Handshake failed: ${JSON.stringify(hs)}`)
  tokenCache.set(k, { token, ts: Date.now() })
  return token
}


function extractChannelList(resp) {
  if (!resp) return []
  if (Array.isArray(resp?.data)) return resp.data
  if (Array.isArray(resp?.js?.data)) return resp.js.data
  if (Array.isArray(resp?.js)) return resp.js
  if (typeof resp?.js === 'string') {
    try { return JSON.parse(resp.js).data || JSON.parse(resp.js) } catch {}
  }
  if (Array.isArray(resp)) return resp
  return []
}


function ensureConfigured() {
  return ensureLoadPhp(userConfig.portal_url) && (userConfig.mac || '').trim()
}

/* ───────────────────────── Stremio Handlers ───────────────────────── */
builder.defineCatalogHandler(async ({ id }) => {
  if (id !== 'stalker_live' || !ensureConfigured()) return { metas: [] }
  const portal = ensureLoadPhp(userConfig.portal_url)
  const mac = userConfig.mac
  try {
    const token = await getTokenFor(portal, mac)
    const channels = await getAllChannels(portal, mac, token)
    console.log(`GOT HERE!`)

    const list = extractChannelList(channels)
    console.log('Extracted channels:', list.length)

    console.log(JSON.stringify(list.length, null, 2))
    const metas = list.map(ch => ({
      id: `stalker:${encodeURIComponent(portal)}|${mac}|${encodeURIComponent(ch.cmd || String(ch.id))}`,
      type: 'tv',
      name: ch.name || `CH ${ch.id}`,
      poster: ch.logo || null,
      description: ch.cmd || ''
    }))
    //console.log('Total channels received:', list.length)
    //console.log('Sample channel data:', list[0])  // show first item to inspect structure

  console.log(`✅ Generated ${metas.length} metas for catalog ${id}`)
  metas.slice(0, 5).forEach((m, i) => {
  console.log(`  [${i + 1}] ${m.name} → id=${m.id}`)
})
console.log('--------------------------------------------------------')

    return { metas }
  } catch (e) {
    console.error('Catalog error:', e?.message)
    return { metas: [] }
  }
})

builder.defineStreamHandler(async ({ id }) => {
  console.log('🎬 Stream request received for:', id)
  const [, rest] = id.split(':', 2)
  const [encPortal, mac, encCmd] = rest.split('|')
  console.log('  Parsed portal:', decodeURIComponent(encPortal))
  console.log('  MAC:', mac)
  console.log('  CMD:', decodeURIComponent(encCmd))
  if (!id.startsWith('stalker:') || !ensureConfigured()) return { streams: [] }
  try {
    const token = await getTokenFor(portal, mac)
    const data = await createLink(portal, mac, token, cmd)
    const streamUrl = data?.js?.cmd || data?.data?.cmd || data?.url || null
    return { streams: streamUrl ? [{ url: streamUrl, title: 'Stalker Portal' }] : [] }
  } catch (e) {
    console.error('Stream error:', e?.message)
    return { streams: [] }
  }
})

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    // Only handle 'tv' metas. If Stremio asks for other types, return null.
    if (type !== 'tv' || !id) return { meta: null }

    // Our ids look like: stalker:<encPortal>|<mac>|<encCmd>
    // Do NOT early-return just because prefix is missing—be forgiving.
    const raw = id.startsWith('stalker:') ? id.slice('stalker:'.length) : id
    const parts = raw.split('|')
    // We expect exactly 3 parts; if not, still return minimal meta.
    const encPortal = parts[0] || ''
    const mac       = parts[1] || ''
    const encCmd    = parts[2] || ''

    let portal = ''
    let cmd = ''
    try { portal = decodeURIComponent(encPortal) } catch { portal = encPortal }
    try { cmd    = decodeURIComponent(encCmd) }    catch { cmd    = encCmd }

    // Minimal meta that ALWAYS returns (prevents empty meta)
    let name = 'Live Channel'
    let poster = null
    let description = cmd || ''

    // Optional enrichment: try to fetch name/logo from portal
    try {
      if (portal && mac) {
        const token   = await getTokenFor(portal, mac)
        const payload = await getAllChannels(portal, mac, token)

        const arr =
          Array.isArray(payload?.data)     ? payload.data :
          Array.isArray(payload?.js?.data) ? payload.js.data : []

        const found = arr.find(ch => {
          const chCmd = ch?.cmd || String(ch?.id ?? '')
          return chCmd === cmd
        })

        if (found) {
          name = found.name || name
          poster = found.logo || poster
          if (!description && found.cmd) description = found.cmd
        }
      }
    } catch (e) {
      // Don’t fail meta; just log for debugging
      console.warn('[meta] enrichment failed:', e?.message)
    }

    // Return a valid meta object no matter what
    return {
      meta: {
        id,
        type: 'tv',
        name,
        poster,
        description,
        logo: poster || null,
        background: poster || null,
        releaseInfo: 'Stalker IPTV'
      }
    }
  } catch (e) {
    console.error('[meta] error:', e?.message)
    // Last resort: still return a minimal meta so Stremio doesn’t bail
    return {
      meta: {
        id,
        type: 'tv',
        name: 'Live Channel',
        description: ''
      }
    }
  }
})

/* ───────────────────────── Web UI & API ───────────────────────── */
const iface = builder.getInterface()
//const router = getRouter(iface)
const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.get('/', (req, res) => {
  const proto = req.socket.encrypted ? 'https' : 'http'
  const host = req.headers.host
  res.send(`
    <h1>Stalker IPTV Add-on</h1>
    <p><a href="${proto}://${host}/configure">Configure</a></p>
    <p>Manifest URL: <code>${proto}://${host}/manifest.json</code></p>
  `)
})

app.get('/configure', (req, res) => {
  const proto = req.socket.encrypted ? 'https' : 'http'
  const host = req.headers.host
  res.type('html').send(`
    <!doctype html><meta charset="utf-8"><title>Configure Stalker Portal</title>
    <style>
      body{font-family:sans-serif;max-width:820px;margin:40px auto;padding:0 16px}
      label{display:block;margin-top:10px}
      input{width:100%;padding:8px}
      button{margin-top:12px;padding:8px 14px}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    </style>
    <h2>Stalker IPTV Configuration</h2>
    <label>Portal URL</label>
    <input id="portal" value="${userConfig.portal_url}" placeholder="http://host/stalker_portal/server/load.php" />
    <div class="row">
      <div>
        <label>MAC Address</label>
        <input id="mac" value="${userConfig.mac}" placeholder="00:1A:79:12:34:56" />
      </div>
      <div>
        <label>Prehash (optional)</label>
        <input id="prehash" value="${userConfig.prehash || ''}" placeholder="EF92F... (if required by portal)" />
      </div>
    </div>
    <div class="row">
      <div><label>stb_lang</label><input id="stb_lang" value="${userConfig.stb_lang}" placeholder="en_IN" /></div>
      <div><label>timezone</label><input id="timezone" value="${userConfig.timezone}" placeholder="Asia/Kolkata" /></div>
    </div>
    <div class="row">
      <div><label>User-Agent</label><input id="ua" value="${userConfig.user_agent}" /></div>
      <div><label>Accept-Language</label><input id="al" value="${userConfig.accept_language}" /></div>
    </div>
    <div>
      <button onclick="save()">Save</button>
      <button onclick="test()">Test</button>
    </div>
    <pre id="out"></pre>
    <p>Manifest URL: <code>${proto}://${host}/manifest.json</code></p>
    <script>
      const out = document.getElementById('out')
      function show(m){ out.textContent = m }
      async function save(){
        const body = {
          portal_url: document.getElementById('portal').value,
          mac: document.getElementById('mac').value,
          prehash: document.getElementById('prehash').value,
          stb_lang: document.getElementById('stb_lang').value,
          timezone: document.getElementById('timezone').value,
          user_agent: document.getElementById('ua').value,
          accept_language: document.getElementById('al').value
        }
        const r = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        const j = await r.json(); show(r.ok ? 'Saved\\n'+JSON.stringify(j,null,2) : 'Error: '+(j.error||''))
      }
      async function test(){
        const body = {
          portal_url: document.getElementById('portal').value,
          mac: document.getElementById('mac').value
        }
        show('Testing...')
        const r = await fetch('/api/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        const j = await r.json(); show(r.ok ? JSON.stringify(j,null,2) : 'Error: '+(j.error||''))
      }
    </script>
  `)
})

app.get('/api/config', (_req, res) => res.json(userConfig))

app.post('/api/config', (req, res) => {
  const { portal_url, mac, prehash, stb_lang, timezone, user_agent, accept_language } = req.body || {}
  if (!portal_url || !mac) return res.status(400).json({ error: 'Missing portal_url or mac' })
  userConfig.portal_url = ensureLoadPhp(portal_url)
  userConfig.mac = mac
  if (prehash !== undefined) userConfig.prehash = prehash
  if (stb_lang) userConfig.stb_lang = stb_lang
  if (timezone) userConfig.timezone = timezone
  if (user_agent) userConfig.user_agent = user_agent
  if (accept_language) userConfig.accept_language = accept_language
  try { saveConfig() } catch {}
  tokenCache.clear()
  res.json(userConfig)
})

app.post('/api/test', async (req, res) => {
  const { portal_url, mac } = req.body || {}
  if (!portal_url || !mac) return res.status(400).json({ error: 'Missing portal_url or mac' })
  try {
    const portal = ensureLoadPhp(portal_url)
    const hs = await handshake(portal, mac)
    const token = extractToken(hs) || ''
    const ch = await getAllChannels(portal, mac, token)
   
    res.json({ ok: true, handshake: hs, token, channels_count: Array.isArray(ch?.data) ? ch.data.length : 0 })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

app.get('/healthz', (_req, res) => res.status(200).send('ok'))

// mount Stremio routes
const router = getRouter(iface)
app.use('/', router)

/* ───────────────────────── HTTPS / HTTP ───────────────────────── */
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 7100)
const SSL_KEY  = process.env.SSL_KEY  || ''
const SSL_CERT = process.env.SSL_CERT || ''
const SSL_CA   = process.env.SSL_CA   || ''

function startHttps() {
  const opts = {
    key:  fs.readFileSync(SSL_KEY),
    cert: fs.readFileSync(SSL_CERT),
    ...(SSL_CA ? { ca: fs.readFileSync(SSL_CA) } : {})
  }
  const server = https.createServer(opts, app)
  server.listen(PORT, HOST, () => console.log(`🔐 HTTPS on https://${HOST}:${PORT}/configure`))
}
if (SSL_KEY && SSL_CERT) {
  try { startHttps() }
  catch (e) {
    console.error('HTTPS failed, fallback to HTTP:', e?.message)
    app.listen(PORT, HOST, () => console.log(`🌐 HTTP on http://${HOST}:${PORT}/configure`))
  }
} else {
  app.listen(PORT, HOST, () => console.log(`🌐 HTTP on http://${HOST}:${PORT}/configure`))
}

