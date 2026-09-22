import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreboard, parseLeagues, describeScoreboard } from '../api/_lib/yahoo.js'

// Shape mirrors Yahoo's fantasy v2 JSON: arrays of single-key objects, numeric-keyed lists with "count".
const team = (key, name, nick, pts, proj, wp) => ({
  team: [
    [{ team_key: key }, { team_id: key.split('.').pop() }, { name }, { team_logos: [{ team_logo: { url: `https://img/${name}.png` } }] },
      { managers: [{ manager: { nickname: nick } }] }],
    { team_points: { coverage_type: 'week', week: '3', total: pts } },
    { team_projected_points: { coverage_type: 'week', week: '3', total: proj } },
    { win_probability: wp },
  ],
})

const sample = {
  fantasy_content: {
    league: [
      { league_key: 'nfl.l.5555', name: 'Sunday Sadness', season: '2026', current_week: 3, scoring_type: 'head', url: 'https://football.fantasysports.yahoo.com/f1/5555' },
      {
        scoreboard: {
          week: '3',
          0: {
            matchups: {
              0: { matchup: { week: '3', status: 'midevent', is_playoffs: '0', is_tied: 0, 0: { teams: { 0: team('nfl.l.5555.t.1', 'Chap Attack', 'Chap', '87.34', '112.5', 0.31), 1: team('nfl.l.5555.t.4', 'Kat Kickers', 'Katherine', '101.10', '108.2', 0.69), count: 2 } } } },
              1: { matchup: { week: '3', status: 'postevent', is_playoffs: '0', is_tied: 0, winner_team_key: 'nfl.l.5555.t.2', 0: { teams: { 0: team('nfl.l.5555.t.2', 'Bench Warmers', 'Sam', '120.00', '120.00', 1), 1: team('nfl.l.5555.t.3', 'Punt Intended', 'Ryan', '64.20', '64.20', 0), count: 2 } } } },
              count: 2,
            },
          },
        },
      },
    ],
  },
}

test('parseScoreboard flattens Yahoo matchups', () => {
  const sb = parseScoreboard(sample)
  assert.equal(sb.league.name, 'Sunday Sadness')
  assert.equal(sb.week, 3)
  assert.equal(sb.matchups.length, 2)
  const [live, final] = sb.matchups
  assert.equal(live.status, 'midevent')
  assert.deepEqual(live.teams.map((t) => t.name), ['Chap Attack', 'Kat Kickers'])
  assert.equal(live.teams[0].points, 87.34)
  assert.equal(live.teams[0].projected, 112.5)
  assert.equal(live.teams[0].winProbability, 0.31)
  assert.deepEqual(live.teams[1].managers, ['Katherine'])
  assert.equal(live.teams[0].logo, 'https://img/Chap Attack.png')
  assert.equal(final.winnerKey, 'nfl.l.5555.t.2')
  assert.equal(final.isPlayoffs, false)
})

test('describeScoreboard renders a compact summary for the roastmaster', () => {
  const text = describeScoreboard(parseScoreboard(sample))
  assert.match(text, /Week 3 of Sunday Sadness/)
  assert.match(text, /Chap Attack \(Chap\) 87\.34 \[proj 112\.5\] vs Kat Kickers \(Katherine\) 101\.1 \[proj 108\.2\] — LIVE/)
  assert.match(text, /Bench Warmers .* — final/)
})

test('parseScoreboard tolerates an empty payload', () => {
  const sb = parseScoreboard({})
  assert.deepEqual(sb.matchups, [])
  assert.equal(sb.week, null)
})

test('parseLeagues lists the signed-in user leagues', () => {
  const json = {
    fantasy_content: {
      users: {
        0: {
          user: [
            { guid: 'ABC' },
            {
              games: {
                0: {
                  game: [
                    { game_key: '470', code: 'nfl', season: '2026' },
                    {
                      leagues: {
                        0: { league: [{ league_key: '470.l.5555', name: 'Sunday Sadness', season: '2026', num_teams: 10, is_finished: 0, url: 'https://x' }] },
                        1: { league: [{ league_key: '470.l.777', name: 'Work League', season: '2026', num_teams: 12, is_finished: 1 }] },
                        count: 2,
                      },
                    },
                  ],
                },
                count: 1,
              },
            },
          ],
        },
        count: 1,
      },
    },
  }
  const leagues = parseLeagues(json)
  assert.equal(leagues.length, 2)
  assert.equal(leagues[0].key, '470.l.5555')
  assert.equal(leagues[0].numTeams, 10)
  assert.equal(leagues[1].isFinished, true)
})
