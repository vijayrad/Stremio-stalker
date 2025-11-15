#!/usr/bin/env node
// Stremio ⇄ Stalker/Ministra IPTV Add-on (Genres-First) — ESM
// Atomic manifest (stable during install), HTTPS ready, verbose logs.
// - Serves /manifest.json from a pre-serialized string (no runtime mutation)
// - Genres refreshed in background; swap manifest atomically when ready
// - ASCII-only placeholder ("Loading...") and safe fallback
// - Version bump only when genres actually change

import sdk from 'stremio-addon-sdk'
import axios from 'axios'
import express from 'express'
import fs from 'fs'
import https from 'https'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const { addonBuilder, getRouter } = sdk

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONFIG_PATH = path.join(__dirname, 'config.json')

let userConfig = {
  portal_url: '',
  mac: '',
  stb_lang: 'en_IN',
  timezone: 'Asia/Kolkata',
  user_agent: 'StalkerTV-Free/40304.13 CFNetwork/3860.200.31 Darwin/25.1.0',
  accept_language: 'en-IN,en-GB;q=0.9,en;q=0.8',
  prehash: '',
  __cfduid: ''
}

if (fs.existsSync(CONFIG_PATH)) {
  try { userConfig = { ...userConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } } catch {}
}
if (!userConfig.__cfduid) {
  userConfig.__cfduid = crypto.randomBytes(16).toString('hex')
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2)) } catch {}
}

function saveConfig() { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2)) } catch {} }
function ensureConfigured() {
  const portal = (userConfig?.portal_url || '').trim()
  const mac    = (userConfig?.mac || '').trim()
  const ok = Boolean(portal && mac)
  if (!ok) console.warn('[Config] portal_url/mac missing. Open /configure to set them.')
  return ok
}

// ---------- Portal helpers ----------
function ensureLoadPhp(anyUrl) {
  const raw = (anyUrl || '').trim(); if (!raw) return ''
  let base = raw.includes('://') ? raw : `http://${raw}`
  const u = new URL(base); let p = u.pathname.replace(/\/+$/, '')
  if (p.endsWith('/server/load.php')) { /* ok */ }
  else if (p.includes('/stalker_portal')) { p = p.replace(/\/+$/, '') + '/server/load.php' }
  else { p = '/server/load.php' }
  u.pathname = p; u.search = ''; return u.toString().replace(/\/+$/, '')
}
function resolveRedirectToLoadPhp(currentBase, location) { const resolved = new URL(location, currentBase).toString(); return ensureLoadPhp(resolved) }
function buildCookie(mac) { return [`mac=${mac}`, `stb_lang=${userConfig.stb_lang || 'en_IN'}`, `timezone=${userConfig.timezone || 'Asia/Kolkata'}`, `__cfduid=${userConfig.__cfduid}`].join('; ') }
function extractToken(hs) { return hs?.token || hs?.js?.token || hs?.data?.token || hs?.js?.data?.token || null }
function extractChannelList(resp) {
  if (!resp) return []; if (Array.isArray(resp?.data)) return resp.data; if (Array.isArray(resp?.js?.data)) return resp.js.data
  if (Array.isArray(resp?.js)) return resp.js; if (typeof resp?.js === 'string') { try { const j = JSON.parse(resp.js); return Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []) } catch {} }
  if (Array.isArray(resp)) return resp; return []
}
function pickList(r) {
  const fromCommon = extractChannelList(r); if (Array.isArray(fromCommon) && fromCommon.length) return fromCommon
  const candidates = [r?.data, r?.js?.data, r?.js, r?.result, r?.results, r?.genres, r?.categories]
  for (const c of candidates) if (Array.isArray(c) && c.length) return c
  if (typeof r?.js === 'string') { try { const j = JSON.parse(r.js); return pickList(j) } catch {} }
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const obj = r.data || r.js?.data || r.genres || r.categories || r
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const entries = Object.entries(obj).map(([id, title]) => ({ id, title }))
      if (entries.length) return entries
    }
  }
  return []
}

async function stalkerGet({ base, mac, action, token, params = {}, includeTokenParam = true, includePrehashParam = true, type = 'stb' }) {
  const q = new URLSearchParams(); q.set('type', type); q.set('action', action)
  if (includeTokenParam) q.set('token', token || '')
  if (includePrehashParam && userConfig.prehash) q.set('prehash', userConfig.prehash)
  q.set('JsHttpRequest', '1-xml'); for (const [k, v] of Object.entries(params || {})) if (v != null) q.set(k, String(v))
  const loadPhp = ensureLoadPhp(base); const url = `${loadPhp}?${q.toString()}`
  const res = await axios.get(url, {
    timeout: 96000, decompress: true,
    headers: { 'Accept': '*/*', 'User-Agent': userConfig.user_agent, 'Authorization': token ? `Bearer ${token}` : '', 'Accept-Language': userConfig.accept_language, 'Accept-Encoding': 'gzip, deflate', 'Cookie': buildCookie(mac) },
    maxRedirects: 0, validateStatus: s => s >= 200 && s < 400
  })
  if (res.status >= 300 && res.status < 400 && res.headers?.location) return { redirectTo: resolveRedirectToLoadPhp(loadPhp, res.headers.location), permanent: (res.status === 301 || res.status === 308) }
  return { data: res.data }
}
async function doRequest({ portalUrl, mac, action, token, params, includeTokenParam = true, includePrehashParam = true, type = 'stb' }) {
  let base = ensureLoadPhp(portalUrl); if (!base) throw new Error('Invalid portal URL')
  for (let hop = 0; hop < 3; hop++) {
    const r = await stalkerGet({ base, mac, action, token, params, includeTokenParam, includePrehashParam, type })
    if (r.redirectTo) {
      const old = base; base = ensureLoadPhp(r.redirectTo); tokenCache.delete(`${old}|${mac}`.toLowerCase())
      if (r.permanent) { userConfig.portal_url = base; saveConfig(); console.log(`🔁 Permanent redirect: ${old} → ${base}`) }
      else { console.log(`↪️ Temporary redirect: ${old} → ${base}`) }
      continue
    }
    return r.data
  }
  throw new Error('Too many redirects contacting portal')
}

const tokenCache = new Map()
async function handshake(baseUrl, mac) { return await doRequest({ portalUrl: baseUrl, mac, action: 'handshake', token: '', params: {}, includeTokenParam: true, includePrehashParam: true, type: 'stb' }) }
async function getTokenFor(baseUrl, mac) {
  const base = ensureLoadPhp(baseUrl); const key = `${base}|${mac}`.toLowerCase(); const cached = tokenCache.get(key)
  if (cached && cached.token && (Date.now() - cached.ts) < 20 * 60 * 1000) return cached.token
  const hs = await handshake(base, mac); const token = extractToken(hs); console.log('🔑 Handshake token:', token ? '[ok]' : '[missing]')
  if (!token) throw new Error('Handshake failed; no token in response')
  tokenCache.set(key, { token, ts: Date.now() }); return token
}

// ---------- Genres cache & helpers ----------
let _genres = null
let _genreById = new Map()
let _genreByTitle = new Map()
function _gfNormName(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim() }
function _gfGetId(g){ return String(g?.id ?? g?.genre_id ?? g?.tv_genre_id ?? g?._id ?? g?.value ?? g?.val ?? g?.ID ?? '').trim() }
function _gfGetTitle(g){ return String(g?.title ?? g?.name ?? g?.text ?? g?.label ?? g?.genre_title ?? g?.tv_genre_title ?? '').trim() }

async function getPortalGenres(baseUrl, mac, token) {
  const actions = ['get_tv_genres', 'get_genres', 'get_categories']; const types = ['stb', 'itv']
  for (const action of actions) for (const t of types) {
    try { const r = await doRequest({ portalUrl: baseUrl, mac, action, token, params: {}, includeTokenParam: true, includePrehashParam: true, type: t })
      const list = pickList(r); if (Array.isArray(list) && list.length) return list } catch {}
  } console.warn('[Genres] No list from portal using any action/type.'); return []
}
function _loadGenres(genList) {
  _genres = Array.isArray(genList) ? genList : []
  _genreById = new Map(); _genreByTitle = new Map()
  for (const g of _genres) { const id = _gfGetId(g); const title = _gfGetTitle(g); if (!id || !title) continue; _genreById.set(id, title); _genreByTitle.set(_gfNormName(title), { id, title }) }
}

// ---------- Atomic manifest ----------
const baseManifest = {
  id: 'org.stalker.iptv',
  version: '2.3.0',
  name: 'Stalker IPTV (Genres First)',
  description: 'Fetches genres from Stalker first; channels load only after a genre selection.',
  resources: ['catalog','meta','stream'],
  types: ['tv'],
  catalogs: [{
    type: 'tv',
    id: 'stalker_live',
    name: 'Live TV (Stalker)',
    extraSupported: ['genre'],
    // We don't require it so Discover can still show previews
    // and users can open the catalog without picking first
    genres: ['All','Loading...'],
    extra: [{ name: 'genre', isRequired: false, options: ['All','Loading...'] }]
  }],
  idPrefixes: ['stalker']
};

// used by addonBuilder; static clone (doesn't need dynamic genres)
const builderManifest = JSON.parse(JSON.stringify(baseManifest))

let cachedGenres = ['All','Loading...']                 // always non-empty
let frozenManifestBody = JSON.stringify(baseManifest) // pre-serialized; what we serve


function rebuildManifestBody() {
  // Build the options list that UI can display
  const opts =
    (cachedGenres && cachedGenres.length
      ? (cachedGenres.includes('All') ? cachedGenres.slice(0) : ['All', ...cachedGenres])
      : ['All']);

  const manifest = {
    ...baseManifest,
    catalogs: [{
      ...baseManifest.catalogs[0],
      // Legacy field many clients still use for the sidebar
      genres: opts,
      // Ensure the catalog explicitly supports the param
      extraSupported: ['genre'],
      // Modern schema that some clients prefer for the sidebar
      extra: [{ name: 'genre', isRequired: false, options: opts }]
    }]
  };

  // Pre-serialize atomically (keeps manifest stable while installing)
  frozenManifestBody = JSON.stringify(manifest);
}

function maybeBumpVersion() {
  const parts = String(baseManifest.version || '1.0.0').split('.').map(n => parseInt(n,10) || 0)
  parts[2] = (parts[2] || 0) + 1
  baseManifest.version = parts.join('.')
  rebuildManifestBody()
}

// initial serialization
rebuildManifestBody()

async function refreshGenres() {
  if (!ensureConfigured()) {
    // keep placeholder; do not mutate manifest during request
    return
  }
  const portal = ensureLoadPhp(userConfig.portal_url); const mac = userConfig.mac; const token = await getTokenFor(portal, mac)
  console.log('[Genres] fetching from portal...')
  const raw = await getPortalGenres(portal, mac, token); _loadGenres(raw)

  const titles = _genres.map(g => _gfGetTitle(g)).filter(s => typeof s === 'string' && s.trim().length > 0)
  const clean = titles.length ? (titles.includes('All') ? titles : ['All', ...titles]) : ['All','Loading...']

  // swap only if changed to avoid needless bumps
  if (JSON.stringify(clean) !== JSON.stringify(cachedGenres)) {
    cachedGenres = clean
    rebuildManifestBody()
    maybeBumpVersion() // bump only on real change
    console.log('[Genres] published count =', cachedGenres.length, 'example =', cachedGenres[0])
  } else {
    console.log('[Genres] unchanged (', cachedGenres.length, 'items )')
  }
}

// ---------- Addon interface ----------
const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use((req, _res, next) => { console.log('[HTTP]', req.method, req.url); next(); })

// Serve manifest as a frozen string (atomic)
app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(frozenManifestBody)
})

app.get('/', (req, res) => {
  const proto = req.socket.encrypted ? 'https' : 'http'; const host = req.headers.host
  res.send(`<h1>Stalker IPTV Add-on</h1>
<p><a href="${proto}://${host}/configure">Configure</a></p>
<p>Manifest URL: <code>${proto}://${host}/manifest.json</code></p>`)
})

app.get('/configure', (req, res) => {
  const proto = req.socket.encrypted ? 'https' : 'http'; const host = req.headers.host
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Configure Stalker Portal</title>
<style>body{font-family:sans-serif;max-width:820px;margin:40px auto;padding:0 16px}label{display:block;margin-top:10px}input{width:100%;padding:8px}button{margin-top:12px;padding:8px 14px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}</style>
<h2>Stalker IPTV Configuration</h2>
<label>Portal URL</label><input id="portal" value="${userConfig.portal_url}" placeholder="http://host/stalker_portal/server/load.php" />
<div class="row">
  <div><label>MAC Address</label><input id="mac" value="${userConfig.mac}" placeholder="00:1A:79:12:34:56" /></div>
  <div><label>Prehash (optional)</label><input id="prehash" value="${userConfig.prehash || ''}" placeholder="EF92F..." /></div>
</div>
<div class="row">
  <div><label>stb_lang</label><input id="stb_lang" value="${userConfig.stb_lang}" placeholder="en_IN" /></div>
  <div><label>timezone</label><input id="timezone" value="${userConfig.timezone}" placeholder="Asia/Kolkata" /></div>
</div>
<div class="row">
  <div><label>User-Agent</label><input id="ua" value="${userConfig.user_agent}" /></div>
  <div><label>Accept-Language</label><input id="al" value="${userConfig.accept_language}" /></div>
</div>
<div><button onclick="save()">Save</button> <button onclick="test()">Test</button></div>
<pre id="out"></pre>
<p>Manifest URL: <code>${proto}://${host}/manifest.json</code></p>
<script>
  const out = document.getElementById('out'); function show(m){ out.textContent = m }
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
    const body = { portal_url: document.getElementById('portal').value, mac: document.getElementById('mac').value }
    show('Testing...')
    const r = await fetch('/api/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    const j = await r.json(); show(r.ok ? JSON.stringify(j,null,2) : 'Error: '+(j.error||''))
  }
</script>`)
})

app.get('/api/config', (_req, res) => res.json(userConfig))

// Save config → refresh genres; DO NOT blindly bump version here
app.post('/api/config', async (req, res) => {
  const { portal_url, mac, prehash, stb_lang, timezone, user_agent, accept_language } = req.body || {}
  if (!portal_url || !mac) return res.status(400).json({ error: 'Missing portal_url or mac' })
  userConfig.portal_url = ensureLoadPhp(portal_url); userConfig.mac = mac
  if (prehash !== undefined) userConfig.prehash = prehash
  if (stb_lang) userConfig.stb_lang = stb_lang
  if (timezone) userConfig.timezone = timezone
  if (user_agent) userConfig.user_agent = user_agent
  if (accept_language) userConfig.accept_language = accept_language
  saveConfig(); tokenCache.clear()
  try { await refreshGenres() } catch (e) { console.warn('refreshGenres after /api/config failed:', e?.message) }
  res.json(userConfig)
})

// Kick a first refresh (non-blocking outcome; manifest already serves placeholder)
await refreshGenres()

// ---------- Addon handlers ----------
const builder = new addonBuilder(builderManifest)

async function getChannelsByGenre(baseUrl, mac, token, genreId) {
  const id = String(genreId)
  const attempts = [['get_all_channels', { genre_id: id }], ['get_all_channels', { tv_genre_id: id }], ['get_all_channels', { category_id: id }], ['get_all_channels', { cat_id: id }], ['get_all_channels', { catid: id }], ['get_all_channels', { group_id: id }], ['get_channels', { genre_id: id }], ['get_channels', { tv_genre_id: id }], ['get_channels', { category_id: id }], ['get_channels', { cat_id: id }], ['get_channels', { catid: id }], ['get_channels', { group_id: id }]]
  const types = ['stb', 'itv']
  for (const [action, params] of attempts) for (const t of types) {
    try { const r = await doRequest({ portalUrl: baseUrl, mac, action, token, params, includeTokenParam: true, includePrehashParam: true, type: t })
      const list = pickList(r); console.log('[ChannelsByGenre] try', action, params, 'type=', t, '→', Array.isArray(list) ? list.length : 'null'); if (Array.isArray(list) && list.length) return list } catch {}
  }
  for (const t of types) {
    try { const rAll = await doRequest({ portalUrl: baseUrl, mac, action: 'get_all_channels', token, params: {}, includeTokenParam: true, includePrehashParam: true, type: t })
      const all = pickList(rAll); if (!Array.isArray(all) || !all.length) continue
      const keys = ['genre_id', 'tv_genre_id', 'category_id', 'cat_id', 'catid', 'group_id', 'tv_genre', 'categoryid','genre','category','categ','categ_id','group','grp_id','section_id','tag_id']
      const filtered = all.filter(ch => keys.some(k => ch?.[k] != null && String(ch[k]) === id))
      console.log('[ChannelsByGenre] fallback (client-filter) size=', filtered.length, 'of', all.length); if (filtered.length) return filtered } catch {}
  } return []
}
function pickLogo(ch) { return ch.logo || ch.icon || ch.img || ch.image || null }

builder.defineCatalogHandler(async ({ id, type = 'tv', extra = {}, skip = 0, limit = 100 }) => {
  if (id !== 'stalker_live') { console.warn('[Catalog] Wrong id:', id, '(expected stalker_live)'); return { metas: [] } }
  if (!ensureConfigured()) { console.warn('[Catalog] Not configured yet; returning empty metas.'); return { metas: [] } }
  if (!_genres || !_genres.length || _genreByTitle.size === 0) { try { await refreshGenres() } catch {} }

  let selectedRaw =
    (extra && (extra.genre ?? extra.Genre ?? extra.category ?? extra.Category)) ??
    (Array.isArray(extra?.genres) && extra.genres[0]) ??
    (Array.isArray(extra?.genre)  && extra.genre[0])  ??
    extra?.search ?? ''
  try { if (typeof selectedRaw === 'string') selectedRaw = decodeURIComponent(selectedRaw) } catch {}
  let selected = Array.isArray(selectedRaw) ? selectedRaw[0] : selectedRaw
  const isNoop = selected === undefined || selected === null || selected === '' || selected === false || selected === true || (typeof selected === 'string' && /^(all|\*|none|false|null|undefined)$/i.test(selected.trim()))
  if (isNoop || /^(all)$/i.test(String(selected||'').trim())) {
    const portal = ensureLoadPhp(userConfig.portal_url); const mac = userConfig.mac; const token = await getTokenFor(portal, mac)
    console.log('[Catalog] No/All genre selected — returning all channels (preview).')
    const payload = await getAllChannels(portal, mac, token)
    const all = extractChannelList(payload)
    const metasAll = Array.isArray(all) ? all.map(ch => ({
      id: `stalker:${encodeURIComponent(portal)}|${mac}|${encodeURIComponent(ch.cmd || String(ch.id))}`,
      type: 'tv', name: ch.name || `CH ${ch.id}`, poster: pickLogo(ch), description: ch.cmd || ''
    })) : []
    const s = Math.max(0, Number(skip) || 0); const l = Math.max(1, Number(limit) || 100); const metas = metasAll.slice(s, s + l)
    return { metas }
  }
  selected = String(selected).trim()

  let rec = _genreByTitle.get(_gfNormName(selected))
  if (!rec) { const title = _genreById.get(String(selected)); if (title) rec = _genreByTitle.get(_gfNormName(title)) }
  if (!rec) { console.warn('[Catalog] Unknown genre:', selected, '| known count:', _genreByTitle.size); return { metas: [] } }

  const portal = ensureLoadPhp(userConfig.portal_url); const mac = userConfig.mac; const token = await getTokenFor(portal, mac)
  console.log('[Catalog] Selected genre =', selected, '→ id =', rec.id)
  const list = await getChannelsByGenre(portal, mac, token, rec.id)
  const metasAll = Array.isArray(list) ? list.map(ch => ({
    id: `stalker:${encodeURIComponent(portal)}|${mac}|${encodeURIComponent(ch.cmd || String(ch.id))}`,
    type: 'tv', name: ch.name || `CH ${ch.id}`, poster: pickLogo(ch), description: ch.cmd || '', genres: [selected],
  })) : []
  const s = Math.max(0, Number(skip) || 0); const l = Math.max(1, Number(limit) || 100); const metas = metasAll.slice(s, s + l)
  console.log('[Catalog] Returning metas:', metas.length); return { metas }
})

function parsePackedId(id) {
  const raw = id.startsWith('stalker:') ? id.slice('stalker:'.length) : id
  const [encPortal = '', mac = '', encCmd = ''] = raw.split('|')
  let portal = encPortal, cmd = encCmd; try { portal = decodeURIComponent(encPortal) } catch {}; try { cmd = decodeURIComponent(encCmd) } catch {}
  const bareCmdUrl = (typeof cmd === 'string' && cmd.startsWith('ffmpeg ')) ? cmd.slice('ffmpeg '.length) : cmd
  return { portal, mac, cmd, bareCmdUrl }
}
async function createLink(baseUrl, mac, token, cmd) { return await doRequest({ portalUrl: baseUrl, mac, action: 'create_link', token, params: { cmd }, includeTokenParam: true, includePrehashParam: true, type: 'stb' }) }

builder.defineStreamHandler(async ({ id }) => {
  try {
    if (!id || !id.startsWith('stalker:')) return { streams: [] }
    const { portal, mac, cmd, bareCmdUrl } = parsePackedId(id)
    const token = await getTokenFor(portal, mac)
    const resp = await createLink(portal, mac, token, bareCmdUrl || cmd)
    console.log('[Stream] create_link keys:', Object.keys(resp || {}))
    const finalUrl = (typeof cmd === 'string' && cmd.startsWith('ffmpeg ')) ? cmd.slice('ffmpeg '.length) : cmd
    return { streams: finalUrl ? [{ url: finalUrl, title: 'Stalker Portal' }] : [] }
  } catch (e) { console.error('[Stream] error:', e?.message); return { streams: [] } }
})

async function getAllChannels(baseUrl, mac, token) { return await doRequest({ portalUrl: baseUrl, mac, action: 'get_all_channels', token, params: {}, includeTokenParam: true, includePrehashParam: true, type: 'itv' }) }
builder.defineMetaHandler(async ({ type, id }) => {
  try {
    if (!id) return { meta: null }
    const raw = id.startsWith('stalker:') ? id.slice('stalker:'.length) : id
    const [encPortal = '', mac = '', encCmd = ''] = raw.split('|')
    let portal = encPortal, cmd = encCmd; try { portal = decodeURIComponent(encPortal) } catch {}; try { cmd = decodeURIComponent(encCmd) } catch {}
    let name = 'Live Channel', poster = null, description = cmd || ''
    try {
      if (portal && mac) {
        const token   = await getTokenFor(portal, mac)
        const payload = await getAllChannels(portal, mac, token)
        const arr = extractChannelList(payload)
        const found = arr.find(ch => (ch?.cmd || String(ch?.id ?? '')) === cmd)
        if (found) { name = found.name || name; poster = found.logo || poster; if (!description && found.cmd) description = found.cmd }
      }
    } catch (e) { console.warn('[META] enrichment failed:', e?.message) }
    return { meta: { id, type: 'tv', name, poster, description, logo: poster || null, background: poster || null, releaseInfo: 'Stalker IPTV' } }
  } catch (e) { console.error('[META] error:', e?.message); return { meta: { id: id || '', type: 'tv', name: 'Live Channel', description: '' } } }
})

// Build interface & debug helpers
const iface = builder.getInterface()

// Debug: list portal genres with ids (useful to test catalog params)
app.get('/api/genres', (_req, res) => {
  try {
    const out = []
    if (globalThis._genres && Array.isArray(globalThis._genres)) {
      for (const g of globalThis._genres) {
        const id = (g.id ?? g._id ?? g.tv_genre_id ?? g.category_id ?? g.cat_id ?? g.catid ?? g.group_id ?? g.categoryid ?? g.tv_genre ?? g.genre_id ?? g.uid ?? g.value ?? g.key ?? g.Id ?? g.ID ?? g.i)
        const title = (g.title ?? g.name ?? g.category ?? g.genre ?? g.text ?? g.label ?? g.Title ?? g.Name ?? g.t)
        out.push({ id, title })
      }
    }
    res.json({ count: out.length, genres: out })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// Mount Stremio router last
app.use('/', getRouter(iface))

// ---------- Server ----------
const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 7100)
const SSL_KEY  = process.env.SSL_KEY  || ''
const SSL_CERT = process.env.SSL_CERT || ''
const SSL_CA   = process.env.SSL_CA   || ''

function startHttps() {
  const opts = { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT), ...(SSL_CA ? { ca: fs.readFileSync(SSL_CA) } : {}) }
  const server = https.createServer(opts, app)
  server.listen(PORT, HOST, () => console.log(`🔐 HTTPS on https://${HOST}:${PORT}/configure`))
}
if (SSL_KEY && SSL_CERT) { try { startHttps() } catch (e) { console.error('HTTPS failed, fallback to HTTP:', e?.message); app.listen(PORT, HOST, () => console.log(`🌐 HTTP on http://${HOST}:${PORT}/configure`)) } }
else { app.listen(PORT, HOST, () => console.log(`🌐 HTTP on http://${HOST}:${PORT}/configure`)) }
