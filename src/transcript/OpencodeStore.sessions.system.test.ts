import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { LiveFixtureWriter } from '../testing/fixtureDatabase.js'
import { sessionRowFor } from '../testing/replay.js'
import { openOpencodeStore, type OpencodeStore } from './OpencodeStore.js'

it('lists only root sessions in the exact directory, newest first with stable ties, and supports a bounded global list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oth-session-list-'))
  let writer: LiveFixtureWriter | undefined
  let store: OpencodeStore | undefined
  try {
    const file = join(dir, 'opencode.db')
    writer = new LiveFixtureWriter(file, 'ses_old', { ...sessionRowFor('ses_old'), directory: '/project', title: 'old root', time_created: 1, time_updated: 10 })
    writer.addSession({ ...sessionRowFor('ses_new_a'), id: 'ses_new_a', directory: '/project', title: 'first tie', time_created: 2, time_updated: 20 })
    writer.addSession({ ...sessionRowFor('ses_new_b'), id: 'ses_new_b', directory: '/project', title: 'second tie', time_created: 3, time_updated: 20 })
    writer.addSession({ ...sessionRowFor('ses_child'), id: 'ses_child', parent_id: 'ses_old', directory: '/project', title: 'task child', time_created: 4, time_updated: 999 })
    writer.addSession({ ...sessionRowFor('ses_foreign'), id: 'ses_foreign', directory: '/project-other', title: 'other root', time_created: 5, time_updated: 30 })
    store = openOpencodeStore(file)
    // Hand-authored expected rows protect both filtering and timestamp source:
    // a child is newest, a sibling path is newer, and creation differs from update.
    expect(store.listSessions({ directory: '/project', limit: 2 })).toEqual([
      { id: 'ses_new_b', title: 'second tie', directory: '/project', timeCreated: 3, timeUpdated: 20 },
      { id: 'ses_new_a', title: 'first tie', directory: '/project', timeCreated: 2, timeUpdated: 20 },
    ])
    expect(store.listSessions({ directory: '/project', limit: 10 }).map(row => row.id)).toEqual(['ses_new_b', 'ses_new_a', 'ses_old'])
    expect(store.listSessions({ directory: '/missing', limit: 10 })).toEqual([])
    expect(store.listSessions({ limit: 3 }).map(row => row.id)).toEqual(['ses_foreign', 'ses_new_b', 'ses_new_a'])
  } finally {
    store?.release()
    writer?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
