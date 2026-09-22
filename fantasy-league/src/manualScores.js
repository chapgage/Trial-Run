// Parse commissioner-typed matchups, one per line:
//   Chap Attack 87.3 - Kat Kickers 101.1
//   Bench Warmers 120 vs Punt Intended 64.2 final
//   Team A - Team B                       (no scores yet = upcoming)
// A trailing word "final", "live" or "upcoming" sets the status; default is live when
// scores are present and upcoming when they are not.

const STATUS_WORDS = { final: 'postevent', live: 'midevent', upcoming: 'preevent', pending: 'preevent' }

function parseSide(text) {
  const m = text.trim().match(/^(.*?)\s+(-?\d+(?:\.\d+)?)$/)
  if (m) return { name: m[1].trim(), points: Number(m[2]) }
  return { name: text.trim(), points: null }
}

export function parseManualScores(text) {
  const matchups = []
  const errors = []
  const lines = String(text || '').split('\n')
  lines.forEach((raw, index) => {
    let line = raw.trim()
    if (!line || line.startsWith('#')) return
    let status = null
    const tail = line.match(/\s+(final|live|upcoming|pending)$/i)
    if (tail) { status = STATUS_WORDS[tail[1].toLowerCase()]; line = line.slice(0, -tail[0].length).trim() }
    const parts = line.split(/\s+(?:-|–|—|vs\.?|v)\s+/i)
    if (parts.length !== 2) { errors.push(`Line ${index + 1}: write it as "Team A 87.3 - Team B 101.1".`); return }
    const a = parseSide(parts[0])
    const b = parseSide(parts[1])
    if (!a.name || !b.name) { errors.push(`Line ${index + 1}: both teams need a name.`); return }
    const hasPoints = a.points != null || b.points != null
    matchups.push({
      status: status || (hasPoints ? 'midevent' : 'preevent'),
      isPlayoffs: false,
      isTied: hasPoints && a.points === b.points,
      winnerKey: null,
      teams: [a, b].map((t, i) => ({
        key: `manual.${matchups.length}.${i}`,
        id: null,
        name: t.name,
        logo: null,
        managers: [],
        points: t.points,
        projected: null,
        winProbability: null,
      })),
    })
  })
  for (const m of matchups) {
    if (m.status === 'postevent') {
      const [a, b] = m.teams
      if (a.points != null && b.points != null && a.points !== b.points) m.winnerKey = a.points > b.points ? a.key : b.key
    }
  }
  return { matchups, errors }
}

export function formatManualScores(matchups) {
  const word = { postevent: 'final', midevent: 'live', preevent: 'upcoming' }
  return (matchups || []).map((m) => {
    const side = (t) => (t.points != null ? `${t.name} ${t.points}` : t.name)
    return `${side(m.teams[0])} - ${side(m.teams[1])} ${word[m.status] || ''}`.trim()
  }).join('\n')
}
