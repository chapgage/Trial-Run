import { supabase, isConfigured } from './supabase.js'

const statusEl = document.getElementById('status')
const entriesEl = document.getElementById('entries')
const form = document.getElementById('guestbook-form')
const submitBtn = document.getElementById('submit-btn')
const formError = document.getElementById('form-error')

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.className = `status status-${kind}`
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function renderEntries(rows) {
  entriesEl.replaceChildren()
  if (!rows.length) {
    const li = document.createElement('li')
    li.className = 'muted'
    li.textContent = 'No entries yet. Be the first!'
    entriesEl.append(li)
    return
  }
  for (const row of rows) {
    const li = document.createElement('li')
    li.className = 'entry'
    const meta = document.createElement('p')
    meta.className = 'entry-meta'
    const name = document.createElement('strong')
    name.textContent = row.name
    meta.append(name, ` · ${formatDate(row.created_at)}`)
    const body = document.createElement('p')
    body.textContent = row.message
    li.append(meta, body)
    entriesEl.append(li)
  }
}

async function loadEntries() {
  const { data, error } = await supabase
    .from('guestbook')
    .select('id, name, message, created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) throw error
  renderEntries(data)
}

async function init() {
  if (!isConfigured) {
    setStatus('Supabase is not configured (missing environment variables).', 'warn')
    entriesEl.replaceChildren()
    submitBtn.disabled = true
    return
  }
  try {
    await loadEntries()
    setStatus('Connected to Supabase', 'ok')
  } catch (err) {
    console.error(err)
    setStatus(`Could not reach Supabase: ${err.message}`, 'error')
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!isConfigured) return
  formError.hidden = true
  const data = new FormData(form)
  const name = String(data.get('name') || '').trim()
  const message = String(data.get('message') || '').trim()
  if (!name || !message) return

  submitBtn.disabled = true
  try {
    const { error } = await supabase.from('guestbook').insert({ name, message })
    if (error) throw error
    form.reset()
    await loadEntries()
  } catch (err) {
    console.error(err)
    formError.textContent = `Could not post: ${err.message}`
    formError.hidden = false
  } finally {
    submitBtn.disabled = false
  }
})

init()
