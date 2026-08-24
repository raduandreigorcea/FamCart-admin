<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import BarChart from '../components/BarChart.vue'
import CopyValue from '../components/CopyValue.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { crumbOf, useLeafCrumb } from '../lib/breadcrumb'
import { banUser, fetchUserDetail, unbanUser } from '../lib/data/users'
import { formatCount, formatDateTime, formatRelative, humanizeKind, initialOf } from '../lib/format'

const route = useRoute()
const router = useRouter()

const userId = computed(() => String(route.params.userId ?? ''))

const detail = useQuery((signal) => fetchUserDetail(userId.value, signal), { watch: [userId] })

useLeafCrumb(() =>
  crumbOf(userId.value, detail.data.value?.profile, (p) => p.user_id, (p) => p.display_name),
)

const profile = computed(() => detail.data.value?.profile ?? null)

// ─── banning ─────────────────────────────────────────────────────────────────
//
// Not a delete. Deleting a profile row does not stick: the app upserts one on
// every boot, so it returns the moment this person opens FamCart. The ban flag
// is what those upserts refuse. Their memberships are deliberately untouched --
// ownership is a membership row, so removing them would strip a household of
// its admin.
const banned = computed(() => Boolean(profile.value?.banned_at))
const confirmingBan = ref(false)
const banReason = ref('')
const banBusy = ref(false)
const banError = ref('')

async function confirmBan() {
  if (banBusy.value) return
  banBusy.value = true
  banError.value = ''
  try {
    if (banned.value) {
      await unbanUser(userId.value, new AbortController().signal)
    } else {
      await banUser(userId.value, banReason.value.trim(), new AbortController().signal)
    }
    confirmingBan.value = false
    banReason.value = ''
    await detail.refetch()
  } catch (caught) {
    banError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    banBusy.value = false
  }
}

const topProducts = computed(() =>
  (detail.data.value?.top_products ?? []).map((p) => ({
    key: `${p.name}-${p.maker ?? ''}`,
    label: p.name,
    meta: p.maker ?? undefined,
    value: p.times,
  })),
)

const errorInfo = computed(() => describeError(detail.error.value))
</script>

<template>
  <div class="page">
    <StateBlock v-if="detail.loading.value" state="loading" :lines="4" />

    <StateBlock
      v-else-if="detail.error.value"
      state="error"
      :title="errorInfo.title"
      :message="errorInfo.detail"
    />

    <StateBlock
      v-else-if="!profile"
      state="empty"
      title="No such account"
      :message="`Nothing on this database has the Clerk id ${userId}. It may belong to the other project, or the profile may never have been created.`"
    >
      <template #action>
        <RouterLink to="/users" class="back">Back to users</RouterLink>
      </template>
    </StateBlock>

    <template v-else>
      <PageHeader
        :title="profile.display_name"
        :fetched-at="detail.fetchedAt.value"
        :busy="detail.fetching.value"
        @refresh="detail.refetch"
      >
        <template #tools>
          <StatusPill v-if="detail.data.value?.is_admin" tone="accent" label="Dashboard admin" />
          <StatusPill v-if="banned" tone="bad" label="Suspended" />
          <button type="button" class="danger" @click="confirmingBan = true">
            {{ banned ? 'Lift suspension' : 'Suspend' }}
          </button>
        </template>
      </PageHeader>

      <div class="identity">
        <img v-if="profile.image_url" class="identity__avatar" :src="profile.image_url" alt="" />
        <span v-else class="identity__initial" aria-hidden="true">{{ initialOf(profile.display_name) }}</span>
        <dl class="identity__facts u-facts">
          <div>
            <dt>Clerk id</dt>
            <dd><CopyValue :value="profile.user_id" label="Clerk id" /></dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd :title="formatDateTime(profile.first_seen)">
              {{ formatRelative(profile.first_seen) }}
              <span class="identity__caveat">earliest join or profile write</span>
            </dd>
          </div>
          <div>
            <dt>Last active</dt>
            <dd :title="formatDateTime(profile.last_active)">
              {{ formatRelative(profile.last_active) }}
              <span class="identity__caveat">last write, not last visit</span>
            </dd>
          </div>
          <div>
            <dt>Profile updated</dt>
            <dd :title="formatDateTime(profile.profile_updated_at)">
              {{ formatRelative(profile.profile_updated_at) }}
            </dd>
          </div>
        </dl>
      </div>

      <div class="grid">
        <div class="span-2">
          <StatTile label="Households" :value="profile.households" hint="Memberships" />
        </div>
        <div class="span-2">
          <StatTile label="Owns" :value="profile.owned_households" hint="Households created" />
        </div>
        <div class="span-2">
          <StatTile label="Moderator of" :value="profile.moderator_of" hint="Elevated rank" />
        </div>
        <div class="span-2">
          <StatTile label="Items added" :value="profile.items_added" hint="Ever, across lists" />
        </div>
        <div class="span-2">
          <StatTile label="Items bought" :value="profile.purchases" hint="Rows in history" />
        </div>
        <div class="span-2">
          <StatTile label="Products added" :value="profile.products_added" hint="Contributed to the catalog" />
        </div>
      </div>

      <div class="grid">
        <div class="span-6">
          <PanelCard title="Households" :note="`${detail.data.value?.households.length ?? 0} membership(s)`" fill flush>
            <StateBlock
              v-if="!detail.data.value?.households.length"
              state="empty"
              title="In no household"
              message="This account has signed in but has not created or joined a household."
              compact
            />
            <ul v-else class="hh">
              <li v-for="hh in detail.data.value.households" :key="hh.id" class="hh__row">
                <RouterLink :to="`/households/${hh.id}`" class="hh__link">
                  <span class="hh__emoji" aria-hidden="true">{{ hh.emoji || '🏠' }}</span>
                  <span class="hh__name u-truncate">{{ hh.name }}</span>
                </RouterLink>
                <StatusPill
                  :tone="hh.is_owner ? 'accent' : hh.role === 'member' ? 'idle' : 'good'"
                  :label="hh.is_owner ? 'Owner' : hh.role === 'member' ? 'Member' : 'Moderator'"
                  :dot="false"
                />
                <span class="hh__meta u-num">{{ formatCount(hh.members) }} members</span>
                <span class="hh__meta u-num">{{ formatCount(hh.items_open) }} open</span>
                <time class="hh__meta" :title="formatDateTime(hh.joined_at)">{{ formatRelative(hh.joined_at) }}</time>
              </li>
            </ul>
          </PanelCard>
        </div>

        <div class="span-6">
          <PanelCard
            title="Buys most often"
            note="From purchase history, by how many separate checkouts included it."
            fill
          >
            <StateBlock
              v-if="!topProducts.length"
              state="empty"
              title="Nothing bought yet"
              message="This account has added items but has never completed a checkout, or has not added any."
              compact
            />
            <BarChart v-else :bars="topProducts" :format="formatCount" dense :limit="10" />
          </PanelCard>
        </div>
      </div>

      <PanelCard
        title="Audit trail"
        note="Rows this account produced in security_events. Empty is the normal state."
        flush
      >
        <StateBlock
          v-if="!detail.data.value?.recent_events.length"
          state="empty"
          title="No events"
          message="This account has not tripped a rate limit, failed an invite code, or had a role changed."
          compact
        />
        <ul v-else class="events">
          <li v-for="(event, index) in detail.data.value.recent_events" :key="index" class="events__row">
            <StatusPill
              :tone="/failed|denied/.test(event.kind) ? 'bad' : /rate_limit|removed/.test(event.kind) ? 'warn' : 'idle'"
              :label="humanizeKind(event.kind)"
            />
            <code class="events__detail u-mono u-truncate">{{ JSON.stringify(event.detail) }}</code>
            <time class="events__when" :title="formatDateTime(event.created_at)">
              {{ formatRelative(event.created_at) }}
            </time>
          </li>
        </ul>
      </PanelCard>

      <p class="foot">
        <button type="button" class="foot__back" @click="router.back()">Back</button>
      </p>
    </template>

    <ConfirmDialog
      :open="confirmingBan"
      :title="banned
        ? `Lift the suspension on ${profile?.display_name ?? 'this account'}?`
        : `Suspend ${profile?.display_name ?? 'this account'}?`"
      :message="banned
        ? 'They can use FamCart again. Their memberships were never removed, so they return to the households they were already in.'
        : 'FamCart refuses them at sign-in. Nothing is deleted and their memberships are left alone, so lifting this puts them straight back.'"
      :confirm-label="banned ? 'Lift suspension' : 'Suspend'"
      tone="danger"
      :busy="banBusy"
      :error="banError"
      @confirm="confirmBan"
      @cancel="confirmingBan = false"
    >
      <!-- The reason is the whole audit value of a suspension: without it the
           security_events row records that something happened and not why. -->
      <input
        v-if="!banned"
        v-model="banReason"
        class="reason"
        type="text"
        placeholder="Why? This goes into the audit trail."
      />
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.danger {
  background: none;
  border: var(--border-width-thin) solid var(--danger-border);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
  color: var(--danger-text);
  cursor: pointer;
}

.danger:hover {
  background: var(--danger-bg);
}

.reason {
  width: 100%;
  height: 34px;
  margin-top: var(--space-3);
  padding: 0 var(--space-3);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--text-primary);
  outline: none;
}

.reason:focus {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-primary);
}

.identity {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  box-shadow: var(--elevation-soft);
}

.identity__avatar,
.identity__initial {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-pill);
  flex: none;
}

.identity__avatar {
  object-fit: cover;
}

.identity__initial {
  display: grid;
  place-items: center;
  background: var(--color-primary-bg);
  color: var(--color-primary-text);
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
}

.identity__facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

.identity__facts dd {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.identity__caveat {
  display: block;
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.hh,
.events {
  list-style: none;
  margin: 0;
  padding: 0;
}

.hh__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.hh__row:last-child,
.events__row:last-child {
  border-bottom: none;
}

.hh__link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  text-decoration: none;
  color: var(--text-primary);
  font-weight: var(--weight-medium);
  font-size: var(--text-sm);
}

.hh__link:hover .hh__name {
  color: var(--color-primary);
  text-decoration: underline;
}

.hh__emoji {
  flex: none;
}

.hh__meta {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.events__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.events__detail {
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  min-width: 0;
}

.events__when {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.foot {
  margin: 0;
}

.foot__back,
.back {
  background: none;
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-sm);
  padding: 0.35rem var(--space-4);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}

.foot__back:hover,
.back:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
