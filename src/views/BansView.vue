<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import UserChip from '../components/UserChip.vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StateBlock from '../components/StateBlock.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, useQueryGroup, describeError } from '../lib/useQuery'
import {
  fetchDeletedHouseholds,
  restoreHousehold,
  type DeletedHouseholdRow,
} from '../lib/data/households'
import { fetchBannedUsers, unbanUser, type BannedUserRow } from '../lib/data/users'
import type { Column } from '../lib/uiTypes'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

// Everything an admin has taken out of circulation, and the way back from each.
//
// Two tables, never merged and never both on screen. They are two different
// removals that only look alike from a distance: a banned account is refused at
// the door and still exists everywhere else -- it keeps its memberships, and the
// households it belongs to carry on without it -- while a withdrawn household is
// hidden wholesale and takes every item and purchase inside it out of view along
// with itself. One combined table would have to invent a column meaning "thing",
// and the two halves would still need different actions in it.
//
// ─── WHY A TOGGLE RATHER THAN TWO STACKED PANELS ────────────────────────────
//
// Both lists are small today and stacking them read fine. They do not stay
// small: a ban is the response to abuse, and abuse arrives in volume. At any
// serious number, a page that renders both puts thousands of rows of the list
// you are not reading between you and the one you are.
//
// People is the default. A ban refuses a real person the app right now, which is
// the more urgent of the two to be looking at.

// ─── which list is on screen ─────────────────────────────────────────────────

type Scope = 'people' | 'households'

const scope = ref<Scope>('people')
const onPeople = computed(() => scope.value === 'people')

// SegmentedControl speaks in plain strings, so the narrowing back to Scope
// happens here rather than being assumed by a v-model. Same shape ProductsView
// uses for the same reason: a control that can emit any string must not be able
// to put any string into this ref.
function setScope(next: string) {
  scope.value = next === 'households' ? 'households' : 'people'
}

// Only the list on screen is fetched. Both used to run on mount, which was
// worth it while the segments carried counts and needed both answers; they do
// not any more, so the hidden query was a round trip for a table nobody was
// looking at -- and at any serious number of bans it is the exact cost the
// toggle exists to avoid. `enabled` is the option useQuery added for this,
// against the same bug on the Products page: it cancels what is in flight when
// a list is hidden and runs when one is shown, and it keeps whatever it already
// fetched, so coming back shows the old rows while they are re-read rather than
// an empty table.
const banned = useQuery((signal) => fetchBannedUsers(signal), {
  enabled: () => onPeople.value,
})
const deleted = useQuery((signal) => fetchDeletedHouseholds(signal), {
  enabled: () => !onPeople.value,
})
const page = useQueryGroup([banned, deleted])

const bannedRows = computed(() => banned.data.value ?? [])
const deletedRows = computed(() => deleted.data.value ?? [])

// Not `rows.length === 0`: that is also true before the first response, and an
// empty list and an unanswered query are different answers. Same rule as
// TablePager's "Counting…".
const noBans = computed(() => banned.data.value !== null && bannedRows.value.length === 0)
const noneDeleted = computed(() => deleted.data.value !== null && deletedRows.value.length === 0)

const bannedError = computed(() =>
  banned.error.value ? describeError(banned.error.value).detail : '',
)
const deletedError = computed(() =>
  deleted.error.value ? describeError(deleted.error.value).detail : '',
)


// Names only. The counts these carried were a way of keeping the hidden list
// visible, which is not what the control is for: it names a choice, and a label
// that also reports a figure is two things at once.
const segments = [
  {
    value: 'people',
    label: 'People',
    title: 'Accounts the app refuses. They keep their households; a ban is a door, not a delete.',
  },
  {
    value: 'households',
    label: 'Households',
    title: 'Households an admin withdrew, hidden along with every item and purchase inside them.',
  },
]

const bannedColumns: Column<BannedUserRow>[] = [
  { key: 'display_name', label: 'Account', width: '26%' },
  { key: 'banned_at', label: 'Banned', sortable: false, width: '14%' },
  { key: 'reason', label: 'Reason', sortable: false, width: '30%', title: 'From the audit trail' },
  { key: 'households', label: 'Households', numeric: true, width: '12%', title: 'Still a member of' },
  { key: 'actions', label: '', align: 'right', width: '18%' },
]

const deletedColumns: Column<DeletedHouseholdRow>[] = [
  { key: 'name', label: 'Household', width: '36%' },
  { key: 'deleted_at', label: 'Withdrawn', sortable: false, width: '22%' },
  { key: 'members', label: 'Members', numeric: true, width: '13%' },
  { key: 'items_total', label: 'Items', numeric: true, width: '13%', title: 'Still inside it' },
  { key: 'actions', label: '', align: 'right', width: '16%' },
]

// ─── the two reversals ───────────────────────────────────────────────────────
//
// One pending target at a time across both tables, because there is one dialog.
// Which kind it is decides what the dialog says and which RPC runs, so it is
// held as a tagged value rather than as two refs that could both be set.

type Pending =
  | { kind: 'user'; row: BannedUserRow }
  | { kind: 'household'; row: DeletedHouseholdRow }

const pending = ref<Pending | null>(null)
const busy = ref(false)
const actionError = ref('')

/**
 * Open and close the dialog, rather than assigning `pending` at four call sites.
 *
 * Both of these clear the error, and that is the whole reason they exist.
 * confirmReversal() was the only thing resetting it, so a failed reversal left
 * the message behind: cancel, press a different row, and the fresh dialog opened
 * already reporting a failure that belonged to another row and had nothing to do
 * with the question being asked.
 */
function ask(next: Pending) {
  actionError.value = ''
  pending.value = next
}

function dismiss() {
  pending.value = null
  actionError.value = ''
}

const dialogTitle = computed(() => {
  const target = pending.value
  if (!target) return ''
  return target.kind === 'user'
    ? `Lift the ban on ${target.row.display_name || 'this account'}?`
    : `Restore ${target.row.name || 'this household'}?`
})

const dialogMessage = computed(() => {
  const target = pending.value
  if (!target) return ''
  return target.kind === 'user'
    ? 'They can open FamCart again straight away. Their households and everything in them are untouched — a ban never removed them.'
    : 'Its members get it back, along with every item and purchase inside it.'
})

const dialogConfirm = computed(() => (pending.value?.kind === 'user' ? 'Lift ban' : 'Restore'))

async function confirmReversal() {
  const target = pending.value
  if (!target || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    if (target.kind === 'user') {
      await unbanUser(target.row.user_id, new AbortController().signal)
      pending.value = null
      await banned.refetch()
    } else {
      await restoreHousehold(target.row.id, new AbortController().signal)
      pending.value = null
      await deleted.refetch()
    }
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Bans"
      description="Accounts the app refuses and households an admin withdrew. Nothing here has been destroyed — both are flags, and both come off from this page."
      :fetched-at="page.fetchedAt.value"
      :busy="page.busy.value"
      @refresh="page.refresh"
    />

    <PanelCard :note="onPeople
      ? 'Refused at the door. Their memberships are left alone.'
      : 'Hidden wholesale, with everything inside them.'" flush>
      <template #actions>
        <SegmentedControl
          :model-value="scope"
          :segments="segments"
          aria-label="Which bans"
          @update:model-value="setScope"
        />
      </template>

      <template v-if="onPeople">
        <StateBlock
          v-if="noBans"
          state="empty"
          title="Nobody is banned"
          message="Banning an account is done from its own page. Anyone banned waits here until the ban is lifted."
        />
        <DataTable
          v-else
          :columns="bannedColumns"
          :rows="bannedRows"
          row-key="user_id"
          :loading="banned.loading.value"
          :error="bannedError"
          empty-title="Nobody is banned"
        >
          <template #cell-display_name="{ row }">
            <UserChip
              :id="String(row.user_id)"
              :name="row.display_name ? String(row.display_name) : null"
              :src="row.image_url ? String(row.image_url) : null"
            />
          </template>

          <template #cell-banned_at="{ row }">
            <span :title="formatDateTime(String(row.banned_at))">
              {{ formatRelative(String(row.banned_at)) }}
            </span>
          </template>

          <!-- A ban may be given with no reason at all, so an empty cell is an
               ordinary answer rather than a missing one. It says so in words
               instead of leaving a blank that reads as a failed lookup. -->
          <template #cell-reason="{ row }">
            <span v-if="row.reason" class="reason" :title="String(row.reason)">{{ row.reason }}</span>
            <span v-else class="reason reason--none">No reason given</span>
            <!-- Who gave it. The audit row records an id, and an id is not
                 somebody a reader recognises -- admin_banned_users resolves it
                 against profiles now, so this is a face and a name. The id is
                 still copyable, one click away on the profile this links to,
                 and the chip falls back to the shortened id when the account
                 has no profile row (the bootstrap admin). -->
            <span v-if="row.banned_by" class="reason__by">
              by
              <UserChip
                :id="String(row.banned_by)"
                :name="row.banned_by_name ? String(row.banned_by_name) : null"
                :src="row.banned_by_image_url ? String(row.banned_by_image_url) : null"
                :size="18"
              />
            </span>
          </template>

          <template #cell-households="{ row }">{{ formatCount(Number(row.households)) }}</template>

          <template #cell-actions="{ row }">
            <button type="button" class="u-btn" @click="ask({ kind: 'user', row })">
              Lift ban
            </button>
          </template>
        </DataTable>
      </template>

      <template v-else>
        <StateBlock
          v-if="noneDeleted"
          state="empty"
          title="Nothing withdrawn"
          message="When an admin deletes a household it waits here until it is restored."
        />
        <DataTable
          v-else
          :columns="deletedColumns"
          :rows="deletedRows"
          row-key="id"
          :loading="deleted.loading.value"
          :error="deletedError"
          empty-title="Nothing withdrawn"
        >
          <!-- A link, because a restore is decided by looking at what is inside
               and this row is the only place a withdrawn household is listed. -->
          <template #cell-name="{ row }">
            <RouterLink :to="`/households/${row.id}`" class="who">
              <span class="who__name">{{ row.emoji ? `${row.emoji} ` : '' }}{{ row.name }}</span>
            </RouterLink>
          </template>

          <template #cell-deleted_at="{ row }">
            <span :title="formatDateTime(String(row.deleted_at))">
              {{ formatRelative(String(row.deleted_at)) }}
            </span>
          </template>

          <template #cell-members="{ row }">{{ formatCount(Number(row.members)) }}</template>
          <template #cell-items_total="{ row }">{{ formatCount(Number(row.items_total)) }}</template>

          <template #cell-actions="{ row }">
            <button type="button" class="u-btn" @click="ask({ kind: 'household', row })">
              Restore
            </button>
          </template>
        </DataTable>
      </template>
    </PanelCard>

    <ConfirmDialog
      :open="pending !== null"
      :title="dialogTitle"
      :message="dialogMessage"
      :confirm-label="dialogConfirm"
      :busy="busy"
      :error="actionError"
      @confirm="confirmReversal"
      @cancel="dismiss"
    />
  </div>
</template>

<style scoped>
.who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  text-decoration: none;
  color: inherit;
}

.who:hover .who__name {
  color: var(--color-primary);
  text-decoration: underline;
}

.who__name {
  font-weight: var(--weight-medium);
  min-width: 0;
}

.reason {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reason--none {
  color: var(--text-disabled);
  font-style: italic;
}

/* Flex for the same reason as .feed__who: "by" is loose text beside a chip, and
   a chip's synthesised baseline comes from its avatar rather than its name. As
   flex items the two centre on each other. */
.reason__by {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}
</style>
