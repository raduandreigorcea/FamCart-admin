<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useUser } from '@clerk/vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import DataTable from '../components/DataTable.vue'
import StatusPill from '../components/StatusPill.vue'
import CopyValue from '../components/CopyValue.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { fetchAdmins, grantAdmin, revokeAdmin, type AdminRow } from '../lib/data/users'
import { appTarget } from '../lib/supabase'
import type { Column } from '../lib/uiTypes'
import { formatDateTime, formatRelative, initialOf, shortUserId } from '../lib/format'

// Who can use this dashboard, and the only two writes it can make.
//
// Both go through admin_grant / admin_revoke, both check admin_guard() first,
// and both leave a row in security_events. The database refuses to let anyone
// revoke their own access, so the tool cannot be used to lock its last operator
// out of it.

const { user } = useUser()
const target = appTarget

const admins = useQuery((signal) => fetchAdmins(signal))

const newUserId = ref('')
const newNote = ref('')
const granting = ref(false)
const grantError = ref('')

const revoking = ref<AdminRow | null>(null)
const revokeBusy = ref(false)
const revokeError = ref('')

const columns: Column[] = [
  { key: 'display_name', label: 'Account', width: '28%' },
  { key: 'user_id', label: 'Clerk id', width: '22%' },
  { key: 'note', label: 'Note', width: '20%' },
  { key: 'granted_by_name', label: 'Granted by', width: '15%', hideBelow: 1100 },
  { key: 'granted_at', label: 'Granted', width: '15%' },
]

const rows = computed(() => (admins.data.value ?? []) as unknown as Record<string, unknown>[])

const canGrant = computed(() => /^user_[A-Za-z0-9]{10,}$/.test(newUserId.value.trim()))

async function grant() {
  if (!canGrant.value) return
  granting.value = true
  grantError.value = ''
  try {
    await grantAdmin(newUserId.value.trim(), newNote.value)
    newUserId.value = ''
    newNote.value = ''
    await admins.refetch()
  } catch (error) {
    grantError.value = error instanceof Error ? error.message : String(error)
  } finally {
    granting.value = false
  }
}

async function confirmRevoke() {
  if (!revoking.value) return
  revokeBusy.value = true
  revokeError.value = ''
  try {
    await revokeAdmin(revoking.value.user_id)
    revoking.value = null
    await admins.refetch()
  } catch (error) {
    revokeError.value = error instanceof Error ? error.message : String(error)
  } finally {
    revokeBusy.value = false
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Access"
      :description="`Accounts in public.admin_users on ${target.label}. Holding a row here is what lets the database answer an admin query at all.`"
      :fetched-at="admins.fetchedAt.value"
      :busy="admins.fetching.value"
      @refresh="admins.refetch"
    />

    <PanelCard title="Admins" note="Every account that can open this dashboard." flush>
      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="user_id"
        :loading="admins.loading.value"
        :error="admins.error.value ? describeError(admins.error.value).detail : ''"
        empty-title="No admins"
        empty-message="This should be impossible while you are reading it, since the page itself requires one."
      >
        <template #cell-display_name="{ row }">
          <div class="who">
            <img v-if="row.image_url" class="who__avatar" :src="String(row.image_url)" alt="" loading="lazy" />
            <span v-else class="who__initial" aria-hidden="true">
              {{ initialOf(row.display_name ? String(row.display_name) : '?') }}
            </span>
            <RouterLink :to="`/users/${encodeURIComponent(String(row.user_id))}`" class="who__link u-truncate">
              {{ row.display_name || 'No profile yet' }}
            </RouterLink>
            <StatusPill v-if="row.is_self" tone="accent" label="You" :dot="false" />
          </div>
        </template>

        <template #cell-user_id="{ row }">
          <CopyValue :value="String(row.user_id)" :display="shortUserId(String(row.user_id))" label="Clerk id" />
        </template>

        <template #cell-note="{ row }">
          <span class="u-truncate u-muted">{{ row.note || '--' }}</span>
        </template>

        <template #cell-granted_by_name="{ row }">
          <span class="u-truncate u-muted">
            {{ row.granted_by ? row.granted_by_name || shortUserId(String(row.granted_by)) : 'seeded by hand' }}
          </span>
        </template>

        <template #cell-granted_at="{ row }">
          <div class="granted">
            <span :title="formatDateTime(String(row.granted_at))">
              {{ formatRelative(String(row.granted_at)) }}
            </span>
            <button
              v-if="!row.is_self"
              type="button"
              class="granted__revoke"
              @click="revoking = row as unknown as AdminRow"
            >Revoke</button>
            <span v-else class="granted__self" title="The database refuses to let an admin revoke their own access">
              cannot revoke
            </span>
          </div>
        </template>
      </DataTable>
    </PanelCard>

    <PanelCard
      title="Grant access"
      note="Takes a Clerk user id. The account does not need a FamCart profile yet, but it will need one to appear by name."
    >
      <form class="grant" @submit.prevent="grant">
        <label class="grant__field">
          <span class="grant__label">Clerk user id</span>
          <input
            v-model="newUserId"
            class="grant__input u-mono"
            type="text"
            placeholder="user_2abcDEF..."
            autocomplete="off"
            spellcheck="false"
          />
        </label>

        <label class="grant__field">
          <span class="grant__label">Note (optional)</span>
          <input
            v-model="newNote"
            class="grant__input"
            type="text"
            placeholder="Why this account has access"
            maxlength="200"
            autocomplete="off"
          />
        </label>

        <button type="submit" class="grant__submit" :disabled="!canGrant || granting">
          {{ granting ? 'Granting…' : 'Grant admin' }}
        </button>
      </form>

      <p v-if="newUserId && !canGrant" class="grant__hint">
        That does not look like a Clerk user id. They start with <code class="u-mono">user_</code>
        followed by letters and digits. Copy one from the Users table.
      </p>
      <p v-if="grantError" class="grant__error">{{ grantError }}</p>

      <p class="grant__foot">
        Your own id is <CopyValue :value="user?.id || ''" label="your Clerk id" />. Granting and
        revoking are both written to <code class="u-mono">security_events</code>, so the roster has a
        history even though this table only holds the present.
      </p>
    </PanelCard>

    <ConfirmDialog
      :open="revoking !== null"
      title="Remove admin access?"
      :message="
        revoking
          ? `${revoking.display_name || shortUserId(revoking.user_id)} will lose access to this dashboard immediately. Every admin query they make will be refused by the database. This does not affect their FamCart account.`
          : ''
      "
      confirm-label="Remove access"
      tone="danger"
      :busy="revokeBusy"
      :error="revokeError"
      @cancel="revoking = null"
      @confirm="confirmRevoke"
    />
  </div>
</template>

<style scoped>
.who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.who__avatar,
.who__initial {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-pill);
  flex: none;
}

.who__avatar {
  object-fit: cover;
}

.who__initial {
  display: grid;
  place-items: center;
  background: var(--color-primary-bg);
  color: var(--color-primary-text);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
}

.who__link {
  color: var(--text-primary);
  text-decoration: none;
  font-weight: var(--weight-medium);
  min-width: 0;
}

.who__link:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.granted {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.granted__revoke {
  background: none;
  border: var(--border-width-thin) solid var(--danger-border);
  color: var(--danger-text);
  border-radius: var(--radius-sm);
  padding: 1px var(--space-2);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  cursor: pointer;
}

.granted__revoke:hover {
  background: var(--danger-bg);
}

.granted__self {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  cursor: help;
}

.grant {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.grant__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 260px;
  min-width: 0;
}

.grant__label {
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-disabled);
}

.grant__input {
  height: 34px;
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--text-primary);
  outline: none;
}

.grant__input:focus {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary);
}

.grant__submit {
  height: 34px;
  padding: 0 var(--space-5);
  background: var(--color-primary);
  color: var(--text-inverse);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--text-base);
  font-weight: var(--weight-bold);
  cursor: pointer;
  box-shadow: var(--elevation-primary);
}

.grant__submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.grant__hint,
.grant__foot {
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: var(--leading-normal);
}

.grant__error {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  background: var(--danger-bg);
  border: var(--border-width-thin) solid var(--danger-border);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--danger-text);
}
</style>
