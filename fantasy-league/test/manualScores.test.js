import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManualScores, formatManualScores } from '../src/manualScores.js'

test('parses typed matchups with scores, statuses and blank lines', () => {
  const { matchups, errors } = parseManualScores(`
    Chap Attack 87.3 - Kat Kickers 101.1
    Bench Warmers 120 vs Punt Intended 64.2 final
    # a comment
    Team Ninety-Nine - Late Bloomers
  `)
  assert.deepEqual(errors, [])
  assert.equal(matchups.length, 3)
  assert.equal(matchups[0].status, 'midevent')
  assert.deepEqual(matchups[0].teams.map((t) => [t.name, t.points]), [['Chap Attack', 87.3], ['Kat Kickers', 101.1]])
  assert.equal(matchups[1].status, 'postevent')
  assert.equal(matchups[1].winnerKey, matchups[1].teams[0].key)
  assert.equal(matchups[2].status, 'preevent')
  assert.equal(matchups[2].teams[0].name, 'Team Ninety-Nine')
  assert.equal(matchups[2].teams[1].points, null)
})

test('reports bad lines by number', () => {
  const { matchups, errors } = parseManualScores('Good Team 10 - Other Team 12\njust one team 44')
  assert.equal(matchups.length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Line 2/)
})

test('round-trips through formatManualScores', () => {
  const text = 'Chap Attack 87.3 - Kat Kickers 101.1 live\nBench Warmers 120 - Punt Intended 64.2 final'
  const { matchups } = parseManualScores(text)
  assert.equal(formatManualScores(matchups), text)
})
