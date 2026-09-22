import { supabase, isConfigured } from './supabase.js'
import { api } from './api.js'
import { parseManualScores, formatManualScores } from './manualScores.js'

// ---------- Config ----------
const AUTO_BURN_EVERY = 8          // write an automatic burn after this many new chat messages
const SCOREBOARD_REFRESH_MS = 60_000
const CHAT_HISTORY = 150

// ---------- State ----------
const state = {
  session: null,
  member: null,
  members: new Map(),   // user_id -> member
  messages: [],
  burns: [],
  scoreboard: null,
  scoreboardError: null,
  league: null,         // commissioner only (ffl_league row)
  burning: false,
}
let channel = null
let scoreboardTimer = null

const app = document.getElementById('app')

// ---------- Tiny DOM helper (no innerHTML with user content) ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function fmtTime(iso) {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function toast(message, kind = 'info') {
  const node = el('div', { class: `toast toast-${kind}`, role: 'status', text: message })
  document.body.append(node)
  setTimeout(() => node.classList.add('show'), 10)
  setTimeout(() => { node.classList.remove('show'); setTimeout(() => node.remove(), 300) }, 4500)
}

// ---------- Auth views ----------
function renderConfigError() {
  app.replaceChildren(
    el('main', { class: 'auth-wrap' },
      el('section', { class: 'card auth-card' },
        el('h1', { class: 'display', text: 'League HQ' }),
        el('p', { class: 'error', text: 'The site is missing its Supabase configuration (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).' }),
      ),
    ),
  )
}

function renderAuth(mode = 'signin') {
  const params = new URLSearchParams(location.search)
  const error = el('p', { class: 'error', hidden: true })
  const notice = el('p', { class: 'notice', hidden: true })
  const isJoin = mode === 'join'

  const form = el('form', { class: 'form', onSubmit: onSubmit },
    isJoin && el('label', {}, 'Invite code',
      el('input', { name: 'code', type: 'text', required: true, autocomplete: 'off', value: params.get('code') || '', placeholder: 'From the commissioner', class: 'mono' })),
    isJoin && el('label', {}, 'Your name (how the league sees you)',
      el('input', { name: 'display_name', type: 'text', required: true, maxlength: '40', autocomplete: 'nickname', placeholder: 'e.g. Chap' })),
    isJoin && el('label', {}, 'Your team name (optional)',
      el('input', { name: 'team_name', type: 'text', maxlength: '60', placeholder: 'Match your Yahoo team name so scores line up' })),
    el('label', {}, 'Email',
      el('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' })),
    el('label', {}, 'Password',
      el('input', { name: 'password', type: 'password', required: true, minlength: '8', autocomplete: isJoin ? 'new-password' : 'current-password', placeholder: isJoin ? 'At least 8 characters' : '••••••••' })),
    el('button', { type: 'submit', class: 'btn btn-primary' }, isJoin ? 'Create account & join' : 'Sign in'),
    error, notice,
  )

  async function onSubmit(event) {
    event.preventDefault()
    error.hidden = true
    notice.hidden = true
    const data = new FormData(form)
    const email = String(data.get('email')).trim()
    const password = String(data.get('password'))
    const button = form.querySelector('button[type=submit]')
    button.disabled = true
    try {
      if (isJoin) {
        // Accounts are created by the ffl-signup edge function: it checks the invite code,
        // creates the login already confirmed (no email step), and adds the member row.
        notice.textContent = 'Creating your account…'
        notice.hidden = false
        const { error: fnError } = await supabase.functions.invoke('ffl-signup', {
          body: {
            email, password,
            display_name: String(data.get('display_name')).trim(),
            team_name: String(data.get('team_name') || '').trim() || null,
            code: String(data.get('code')).trim(),
          },
        })
        if (fnError) {
          let message = fnError.message || 'Could not create the account.'
          try { message = (await fnError.context?.json())?.error || message } catch { /* keep default */ }
          throw new Error(message)
        }
        notice.textContent = 'Account created. Signing you in…'
        history.replaceState(null, '', location.pathname)
      }
      const { error: err } = await supabase.auth.signInWithPassword({ email, password })
      if (err) throw err
    } catch (err) {
      notice.hidden = true
      error.textContent = err.message || 'Something went wrong.'
      error.hidden = false
    } finally {
      button.disabled = false
    }
  }

  app.replaceChildren(
    el('main', { class: 'auth-wrap' },
      el('section', { class: 'card auth-card' },
        el('p', { class: 'eyebrow', text: 'Members only' }),
        el('h1', { class: 'display', text: 'League HQ' }),
        el('p', { class: 'lede', text: 'Live scores, league chat, and the burn board. You need an invite code from the commissioner to get in.' }),
        el('div', { class: 'segmented', role: 'tablist' },
          el('button', { type: 'button', class: `seg ${!isJoin ? 'active' : ''}`, onClick: () => renderAuth('signin') }, 'Sign in'),
          el('button', { type: 'button', class: `seg ${isJoin ? 'active' : ''}`, onClick: () => renderAuth('join') }, 'New here? Join'),
        ),
        form,
      ),
    ),
  )
}

function renderJoinGate() {
  const params = new URLSearchParams(location.search)
  const error = el('p', { class: 'error', hidden: true })
  const user = state.session.user
  const form = el('form', { class: 'form', onSubmit: onSubmit },
    el('label', {}, 'Invite code',
      el('input', { name: 'code', type: 'text', required: true, autocomplete: 'off', value: params.get('code') || '', placeholder: 'From the commissioner', class: 'mono' })),
    el('label', {}, 'Your name',
      el('input', { name: 'display_name', type: 'text', required: true, maxlength: '40', value: user.user_metadata?.display_name || '', placeholder: 'How the league sees you' })),
    el('label', {}, 'Your team name (optional)',
      el('input', { name: 'team_name', type: 'text', maxlength: '60', placeholder: 'Match your Yahoo team name so scores line up' })),
    el('button', { type: 'submit', class: 'btn btn-primary' }, 'Join the league'),
    error,
  )

  async function onSubmit(event) {
    event.preventDefault()
    error.hidden = true
    const data = new FormData(form)
    const button = form.querySelector('button[type=submit]')
    button.disabled = true
    try {
      const { data: member, error: err } = await supabase.rpc('ffl_join_league', {
        code: String(data.get('code')).trim(),
        display_name: String(data.get('display_name')).trim(),
        team_name: String(data.get('team_name') || '').trim() || null,
      })
      if (err) throw err
      state.member = member
      history.replaceState(null, '', location.pathname)
      await enterLeague()
    } catch (err) {
      error.textContent = err.message || 'Could not join.'
      error.hidden = false
      button.disabled = false
    }
  }

  app.replaceChildren(
    el('main', { class: 'auth-wrap' },
      el('section', { class: 'card auth-card' },
        el('p', { class: 'eyebrow', text: `Signed in as ${user.email}` }),
        el('h1', { class: 'display', text: 'One more step' }),
        el('p', { class: 'lede', text: 'Enter the invite code to unlock the league.' }),
        form,
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: signOut }, 'Sign out'),
      ),
    ),
  )
}

async function signOut() {
  await supabase.auth.signOut()
}

// ---------- Data loading ----------
async function loadMember() {
  const { data, error } = await supabase.from('ffl_members').select('*').eq('user_id', state.session.user.id).maybeSingle()
  if (error) throw error
  state.member = data
  return data
}

async function loadMembers() {
  const { data, error } = await supabase.from('ffl_members').select('user_id, display_name, team_name, is_commissioner')
  if (error) throw error
  state.members = new Map(data.map((m) => [m.user_id, m]))
}

async function loadMessages() {
  const { data, error } = await supabase
    .from('ffl_messages')
    .select('id, user_id, body, created_at')
    .order('id', { ascending: false })
    .limit(CHAT_HISTORY)
  if (error) throw error
  state.messages = data.reverse()
}

async function loadBurns() {
  const { data, error } = await supabase
    .from('ffl_burns')
    .select('id, target, headline, burn, prompt, source, requested_by, last_message_id, created_at')
    .order('id', { ascending: false })
    .limit(30)
  if (error) throw error
  state.burns = data
}

async function loadLeagueRow() {
  if (!state.member?.is_commissioner) return
  const { data } = await supabase.from('ffl_league').select('*').eq('id', 1).maybeSingle()
  state.league = data
}

async function refreshScoreboard() {
  try {
    state.scoreboard = await api('/api/scoreboard')
    state.scoreboardError = null
  } catch (err) {
    state.scoreboardError = err
  }
  renderScoreboard()
  renderHeaderMeta()
}

function subscribeRealtime() {
  if (channel) supabase.removeChannel(channel)
  channel = supabase
    .channel('league-hq')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ffl_messages' }, async ({ new: row }) => {
      if (state.messages.some((m) => m.id === row.id)) return
      state.messages.push(row)
      if (!state.members.has(row.user_id)) await loadMembers().catch(() => {})
      renderMessages()
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ffl_burns' }, ({ new: row }) => {
      if (state.burns.some((b) => b.id === row.id)) return
      state.burns.unshift(row)
      renderBurns()
      toast(`🔥 New burn: ${row.headline}`, 'burn')
    })
    .subscribe()
}

// ---------- Main app ----------
async function enterLeague() {
  await Promise.all([loadMembers(), loadMessages(), loadBurns(), loadLeagueRow()])
  renderShell()
  renderMessages()
  renderBurns()
  subscribeRealtime()
  refreshScoreboard()
  clearInterval(scoreboardTimer)
  scoreboardTimer = setInterval(refreshScoreboard, SCOREBOARD_REFRESH_MS)
  handleReturnParams()
}

function handleReturnParams() {
  const params = new URLSearchParams(location.search)
  if (params.get('yahoo') === 'connected') toast('Yahoo connected. Scores will appear shortly.', 'ok')
  if (params.get('yahoo') === 'pick') { toast('Yahoo connected. Pick which league to track in Settings.', 'info'); openSettings() }
  if (params.get('yahoo') === 'error') toast(`Yahoo connection failed: ${params.get('message') || 'unknown error'}`, 'error')
  if (params.get('yahoo') === 'pending') { toast(params.get('message') || 'Yahoo approval pending.', 'info'); openSettings() }
  if (params.has('yahoo')) history.replaceState(null, '', location.pathname)
}

function renderShell() {
  const isCommish = state.member.is_commissioner
  const grid = el('main', { class: 'grid', id: 'grid', dataset: { active: 'scores' } },
    el('section', { class: 'panel', id: 'panel-scores', 'aria-label': 'Scoreboard' },
      el('header', { class: 'panel-head' },
        el('h2', { class: 'display', text: 'Scoreboard' }),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: refreshScoreboard, title: 'Refresh now' }, '↻ Refresh')),
      el('div', { id: 'scoreboard', class: 'panel-body' }, el('p', { class: 'muted', text: 'Loading scores…' }))),
    el('section', { class: 'panel', id: 'panel-chat', 'aria-label': 'League chat' },
      el('header', { class: 'panel-head' },
        el('h2', { class: 'display', text: 'Chat' }),
        el('span', { class: 'muted small', id: 'member-count' })),
      el('div', { id: 'messages', class: 'panel-body messages' }),
      chatForm()),
    el('section', { class: 'panel', id: 'panel-burns', 'aria-label': 'Burn board' },
      el('header', { class: 'panel-head' },
        el('h2', { class: 'display', text: 'Burn board' }),
        el('button', { type: 'button', class: 'btn btn-fire btn-sm', id: 'burn-btn', onClick: () => requestBurn(true) }, '🔥 Write a burn')),
      el('div', { id: 'burns', class: 'panel-body' })),
  )

  const tabs = el('nav', { class: 'tabs', 'aria-label': 'Sections' },
    ...[['scores', 'Scores'], ['chat', 'Chat'], ['burns', 'Burns']].map(([key, label]) =>
      el('button', { type: 'button', class: `tab ${key === 'scores' ? 'active' : ''}`, dataset: { tab: key }, onClick: (e) => {
        grid.dataset.active = key
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === e.currentTarget))
      } }, label)))

  app.replaceChildren(
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'ball', 'aria-hidden': 'true', text: '🏈' }),
        el('span', { class: 'display', id: 'league-name', text: state.league?.name || 'League HQ' }),
        el('span', { class: 'pill', id: 'week-pill', hidden: true })),
      el('div', { class: 'userbox' },
        el('span', { class: 'muted small', text: state.member.display_name + (isCommish ? ' · Commissioner' : '') }),
        isCommish && el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: openSettings }, 'Settings'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: signOut }, 'Sign out'))),
    tabs,
    grid,
  )
  document.getElementById('member-count').textContent = `${state.members.size} member${state.members.size === 1 ? '' : 's'}`
}

function renderHeaderMeta() {
  const pill = document.getElementById('week-pill')
  const name = document.getElementById('league-name')
  if (!pill) return
  const sb = state.scoreboard
  if (sb?.league?.name) name.textContent = sb.league.name
  if (sb?.week) { pill.textContent = `Week ${sb.week}`; pill.hidden = false }
}

// ---------- Scoreboard ----------
const STATUS = { preevent: ['Upcoming', 'status-pre'], midevent: ['Live', 'status-live'], postevent: ['Final', 'status-final'] }

function renderScoreboard() {
  const root = document.getElementById('scoreboard')
  if (!root) return
  if (state.scoreboardError) {
    const err = state.scoreboardError
    const needsSetup = err.status === 409 || err.status === 500
    root.replaceChildren(
      el('div', { class: 'empty' },
        el('p', { text: needsSetup ? 'Scores are not connected yet.' : 'Could not load scores.' }),
        el('p', { class: 'muted small', text: err.message }),
        state.member.is_commissioner && needsSetup && el('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: openSettings }, 'Open Settings'),
        !state.member.is_commissioner && needsSetup && el('p', { class: 'muted small', text: 'The commissioner can type this week\u2019s scores in Settings in the meantime.' })))
    return
  }
  const sb = state.scoreboard
  if (!sb) return
  if (!sb.matchups?.length) {
    root.replaceChildren(el('div', { class: 'empty' }, el('p', { text: 'No matchups for this week yet.' })))
    return
  }
  root.replaceChildren(
    ...sb.matchups.map((m) => {
      const [label, cls] = STATUS[m.status] || [m.status, '']
      const [a, b] = m.teams
      return el('article', { class: `matchup ${m.status === 'midevent' ? 'is-live' : ''}` },
        el('div', { class: 'matchup-meta' },
          el('span', { class: `status ${cls}`, text: label }),
          m.isPlayoffs && el('span', { class: 'pill', text: 'Playoffs' })),
        teamRow(a, m), teamRow(b, m),
        winBar(a, b, m))
    }),
    el('p', { class: 'muted small updated', text: sb.source === 'manual'
      ? `Entered by the commissioner${sb.updatedAt ? ' · ' + fmtTime(sb.updatedAt) : ''} · Yahoo takes over automatically once approved`
      : `Updated ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · refreshes every minute` }),
  )
}

function teamRow(team, m) {
  const winning = m.status !== 'preevent' && team.points != null && m.teams.every((t) => t === team || (t.points ?? 0) < team.points)
  return el('div', { class: `team ${winning ? 'is-winning' : ''} ${m.winnerKey === team.key ? 'is-winner' : ''}` },
    team.logo ? el('img', { class: 'logo', src: team.logo, alt: '' }) : el('span', { class: 'logo logo-blank' }),
    el('div', { class: 'team-names' },
      el('span', { class: 'team-name', text: team.name }),
      el('span', { class: 'muted small', text: team.managers.join(', ') })),
    el('div', { class: 'team-score' },
      el('span', { class: 'points', text: team.points != null ? team.points.toFixed(2) : '—' }),
      team.projected != null && el('span', { class: 'muted small', text: `proj ${team.projected.toFixed(1)}` })))
}

function winBar(a, b, m) {
  if (m.status === 'postevent' || a.winProbability == null) return null
  const pa = Math.round(Number(a.winProbability) * 100)
  return el('div', { class: 'winbar', title: `${a.name} ${pa}% · ${b.name} ${100 - pa}%` },
    el('span', { class: 'winbar-a', style: `width:${pa}%` }),
    el('span', { class: 'winbar-label', text: `${pa}% – ${100 - pa}%` }))
}

// ---------- Chat ----------
function chatForm() {
  const input = el('input', { name: 'body', type: 'text', maxlength: '1000', required: true, autocomplete: 'off', placeholder: 'Talk your talk…' })
  const form = el('form', { class: 'chat-form', onSubmit: async (event) => {
    event.preventDefault()
    const body = input.value.trim()
    if (!body) return
    input.disabled = true
    try {
      const { data, error } = await supabase.from('ffl_messages').insert({ user_id: state.member.user_id, body }).select().single()
      if (error) throw error
      input.value = ''
      if (!state.messages.some((m) => m.id === data.id)) { state.messages.push(data); renderMessages() }
      maybeAutoBurn()
    } catch (err) {
      toast(`Could not send: ${err.message}`, 'error')
    } finally {
      input.disabled = false
      input.focus()
    }
  } }, input, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Send'))
  return form
}

function renderMessages() {
  const root = document.getElementById('messages')
  if (!root) return
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80
  if (!state.messages.length) {
    root.replaceChildren(el('div', { class: 'empty' }, el('p', { text: 'Nobody has said anything yet. Set the tone.' })))
    return
  }
  let lastUser = null
  root.replaceChildren(
    ...state.messages.map((m) => {
      const member = state.members.get(m.user_id)
      const mine = m.user_id === state.member.user_id
      const showName = m.user_id !== lastUser
      lastUser = m.user_id
      return el('div', { class: `msg ${mine ? 'mine' : ''} ${showName ? 'first' : ''}` },
        showName && el('div', { class: 'msg-meta' },
          el('strong', { text: member?.display_name || 'Someone' }),
          member?.team_name && el('span', { class: 'muted', text: ` · ${member.team_name}` }),
          el('span', { class: 'muted', text: ` · ${fmtTime(m.created_at)}` })),
        el('div', { class: 'msg-body', text: m.body }))
    }),
  )
  if (nearBottom || lastUser === state.member.user_id) root.scrollTop = root.scrollHeight
}

function maybeAutoBurn() {
  const latest = state.burns[0]
  const since = state.messages.filter((m) => m.id > (latest?.last_message_id ?? 0)).length
  if (since >= AUTO_BURN_EVERY) requestBurn(false)
}

// ---------- Burns ----------
async function requestBurn(force) {
  if (state.burning) return
  state.burning = true
  const btn = document.getElementById('burn-btn')
  if (btn) { btn.disabled = true; btn.textContent = force ? 'Cooking…' : '🔥 Write a burn' }
  try {
    const result = await api('/api/burn', { method: 'POST', body: { force } })
    if (result.skipped && force) toast('A burn just landed. Give it a minute before the next one.', 'info')
    if (result.burn && !state.burns.some((b) => b.id === result.burn.id)) { state.burns.unshift(result.burn); renderBurns() }
  } catch (err) {
    if (force) toast(`Burn failed: ${err.message}`, 'error')
  } finally {
    state.burning = false
    if (btn) { btn.disabled = false; btn.textContent = '🔥 Write a burn' }
  }
}

function renderBurns() {
  const root = document.getElementById('burns')
  if (!root) return
  if (!state.burns.length) {
    root.replaceChildren(el('div', { class: 'empty' },
      el('p', { text: 'No burns yet.' }),
      el('p', { class: 'muted small', text: `One gets written automatically every ${AUTO_BURN_EVERY} chat messages, or hit the button.` })))
    return
  }
  root.replaceChildren(
    ...state.burns.map((b) => el('article', { class: 'burn' },
      el('div', { class: 'burn-meta' },
        b.target && el('span', { class: 'pill pill-target', text: `🎯 ${b.target}` }),
        el('span', { class: 'muted small', text: `${b.source === 'manual' ? 'requested by ' + (state.members.get(b.requested_by)?.display_name || 'a member') : b.source === 'cron' ? 'Sunday special' : 'auto'} · ${fmtTime(b.created_at)}` })),
      el('h3', { class: 'display burn-headline', text: b.headline }),
      el('p', { class: 'burn-body', text: b.burn }),
      el('div', { class: 'burn-prompt' },
        el('span', { class: 'burn-prompt-label', text: 'Discuss' }),
        el('span', { text: b.prompt }),
        el('button', { type: 'button', class: 'btn btn-ghost btn-xs', title: 'Quote in chat', onClick: () => {
          const input = document.querySelector('.chat-form input')
          if (input) { input.value = `“${b.prompt}” `; document.getElementById('grid').dataset.active = 'chat'; input.focus() }
        } }, 'Reply in chat')))),
  )
}

// ---------- Settings (commissioner) ----------
async function openSettings() {
  if (!state.member?.is_commissioner) return
  document.getElementById('settings')?.remove()
  await loadLeagueRow()
  const league = state.league || { name: 'The League', invite_code: '' }
  const error = el('p', { class: 'error', hidden: true })
  const inviteLink = () => `${location.origin}/?code=${encodeURIComponent(league.invite_code)}`

  const nameInput = el('input', { name: 'name', type: 'text', required: true, maxlength: '60', value: league.name })
  const codeInput = el('input', { name: 'invite_code', type: 'text', required: true, maxlength: '60', value: league.invite_code, class: 'mono' })
  const keyInput = el('input', { name: 'yahoo_league_key', type: 'text', maxlength: '40', value: league.yahoo_league_key || '', placeholder: 'nfl.l.123456', class: 'mono' })
  const linkOut = el('code', { class: 'invite-link', text: inviteLink() })

  const leaguePicker = el('div', { class: 'league-picker' })
  const yahooStatus = el('p', { class: 'muted small', text: 'Checking Yahoo connection…' })

  // Manual scores (fallback while Yahoo approval is pending)
  const weekInput = el('input', { name: 'manual_week', type: 'number', min: '1', max: '20', value: String(state.scoreboard?.week || 1), style: 'max-width:90px' })
  const scoresInput = el('textarea', { name: 'manual_scores', rows: '6', class: 'mono', placeholder: 'Chap Attack 87.3 - Kat Kickers 101.1\nBench Warmers 120 - Punt Intended 64.2 final\nTeam A - Team B' })
  const manualStatus = el('p', { class: 'muted small', text: 'One matchup per line: "Team A 87.3 - Team B 101.1". Add "final" at the end when a game is over; leave scores off for games not yet played.' })
  const manualError = el('p', { class: 'error', hidden: true })
  supabase.from('ffl_manual_scores').select('week, matchups, updated_at').order('week', { ascending: false }).limit(1).maybeSingle().then(({ data }) => {
    if (data) { weekInput.value = String(data.week); scoresInput.value = formatManualScores(data.matchups); manualStatus.textContent = `Week ${data.week} scores last saved ${fmtTime(data.updated_at)}. Edit and save to update.` }
  })
  async function saveManualScores() {
    manualError.hidden = true
    const week = Number(weekInput.value)
    const { matchups, errors } = parseManualScores(scoresInput.value)
    if (!week || week < 1 || week > 20) { manualError.textContent = 'Week must be between 1 and 20.'; manualError.hidden = false; return }
    if (errors.length) { manualError.textContent = errors.join(' '); manualError.hidden = false; return }
    if (!matchups.length) {
      const { error: dErr } = await supabase.from('ffl_manual_scores').delete().eq('week', week)
      if (dErr) { manualError.textContent = dErr.message; manualError.hidden = false; return }
      toast(`Week ${week} manual scores cleared.`, 'ok'); refreshScoreboard(); return
    }
    const { error: uErr } = await supabase.from('ffl_manual_scores').upsert({ week, matchups, updated_by: state.member.user_id, updated_at: new Date().toISOString() })
    if (uErr) { manualError.textContent = uErr.message; manualError.hidden = false; return }
    toast(`Week ${week} scores saved (${matchups.length} matchup${matchups.length === 1 ? '' : 's'}).`, 'ok')
    refreshScoreboard()
  }

  const dialog = el('dialog', { id: 'settings', class: 'dialog' },
    el('form', { method: 'dialog', class: 'form', onSubmit: async (event) => {
      event.preventDefault()
      error.hidden = true
      try {
        const patch = { name: nameInput.value.trim(), invite_code: codeInput.value.trim(), yahoo_league_key: keyInput.value.trim() || null }
        const { error: err } = await supabase.from('ffl_league').update(patch).eq('id', 1)
        if (err) throw err
        Object.assign(league, patch)
        state.league = league
        linkOut.textContent = inviteLink()
        document.getElementById('league-name').textContent = league.name
        toast('Settings saved.', 'ok')
        refreshScoreboard()
        dialog.close()
      } catch (err) {
        error.textContent = err.message
        error.hidden = false
      }
    } },
      el('h2', { class: 'display', text: 'League settings' }),
      el('label', {}, 'League name', nameInput),
      el('label', {}, 'Invite code (share only with members)', codeInput),
      el('p', { class: 'muted small' }, 'Invite link: ', linkOut, ' ',
        el('button', { type: 'button', class: 'btn btn-ghost btn-xs', onClick: async () => { await navigator.clipboard?.writeText(inviteLink()); toast('Invite link copied.', 'ok') } }, 'Copy')),
      el('hr'),
      el('h3', { text: 'Yahoo Fantasy' }),
      yahooStatus,
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: connectYahoo }, 'Connect Yahoo account'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: loadLeaguePicker }, 'Find my leagues')),
      leaguePicker,
      el('label', {}, 'Yahoo league key', keyInput),
      el('hr'),
      el('h3', { text: 'Type in scores (while Yahoo approval is pending)' }),
      manualStatus,
      el('label', {}, 'Week', weekInput),
      el('label', {}, 'Matchups', scoresInput),
      manualError,
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: saveManualScores }, 'Save scores')),
      error,
      el('div', { class: 'row end' },
        el('button', { type: 'button', class: 'btn btn-ghost', onClick: () => dialog.close() }, 'Cancel'),
        el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'))),
  )
  document.body.append(dialog)
  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())

  api('/api/yahoo/leagues').then((res) => {
    yahooStatus.textContent = res.connected
      ? `Connected${res.tokenUpdatedAt ? ' · last refreshed ' + fmtTime(res.tokenUpdatedAt) : ''}. Tracking: ${league.yahoo_league_key || 'not chosen yet'}.`
      : 'Not connected. Click “Connect Yahoo account” and sign in with the Yahoo login that owns the league.'
  }).catch((err) => { yahooStatus.textContent = err.message })

  async function connectYahoo() {
    try {
      const { url } = await api('/api/yahoo/connect', { method: 'POST' })
      location.assign(url)
    } catch (err) {
      error.textContent = err.message
      error.hidden = false
    }
  }

  async function loadLeaguePicker() {
    leaguePicker.replaceChildren(el('p', { class: 'muted small', text: 'Looking up your leagues…' }))
    try {
      const { leagues } = await api('/api/yahoo/leagues?discover=1')
      if (!leagues?.length) { leaguePicker.replaceChildren(el('p', { class: 'muted small', text: 'No NFL leagues found on that Yahoo account this season.' })); return }
      leaguePicker.replaceChildren(
        ...leagues.map((l) => el('button', { type: 'button', class: 'btn btn-ghost btn-sm league-option', onClick: () => { keyInput.value = l.key; nameInput.value = nameInput.value || l.name } },
          `${l.name} · ${l.season} · ${l.numTeams} teams`, el('code', { class: 'mono small', text: l.key }))))
    } catch (err) {
      leaguePicker.replaceChildren(el('p', { class: 'error', text: err.message }))
    }
  }
}

// ---------- Boot ----------
async function handleSession(session) {
  state.session = session
  if (!session) {
    clearInterval(scoreboardTimer)
    if (channel) { supabase.removeChannel(channel); channel = null }
    state.member = null
    renderAuth(new URLSearchParams(location.search).has('code') ? 'join' : 'signin')
    return
  }
  try {
    const member = await loadMember()
    if (!member) return renderJoinGate()
    await enterLeague()
  } catch (err) {
    console.error(err)
    toast(err.message, 'error')
  }
}

if (!isConfigured) {
  renderConfigError()
} else {
  supabase.auth.getSession().then(({ data }) => handleSession(data.session))
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && state.session?.user?.id === session?.user?.id) return   // token refresh, ignore
    if (event === 'TOKEN_REFRESHED') { state.session = session; return }
    handleSession(session)
  })
}
