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
import SideDrawer from '../components/SideDrawer.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { crumbOf, useLeafCrumb } from '../lib/breadcrumb'
import { fetchHouseholdDetail, type HouseholdDetail } from '../lib/data/households'
import { formatCount, formatDateTime, formatRelative, initialOf, shortUserId } from '../lib/format'

const route = useRoute()
const router = useRouter()

const householdId = computed(() => String(route.params.householdId ?? ''))

const detail = useQuery((signal) => fetchHouseholdDetail(householdId.value, signal), {
  watch: [householdId],
})

useLeafCrumb(() =>
  crumbOf(householdId.value, detail.data.value?.household, (h) => h.id, (h) => h.name),
)

const household = computed(() => detail.data.value?.household ?? null)
const errorInfo = computed(() => describeError(detail.error.value))

// The list is shown filtered rather than in two blocks: an operator looking at a
// household usually wants "what is outstanding", and the checked rows are
// history that purchase_history already tells better.
const listFilter = ref('open')

const listRows = computed(() => {
  const rows = detail.data.value?.list ?? []
  if (listFilter.value === 'open') return rows.filter((r) => !r.checked)
  if (listFilter.value === 'checked') return rows.filter((r) => r.checked)
  return rows
})

const topProducts = computed(() =>
  (detail.data.value?.top_products ?? []).map((p) => ({
    key: `${p.name}-${p.maker ?? ''}`,
    label: p.name,
    meta: p.maker ?? undefined,
    value: p.times,
  })),
)

// The checkout drawer: one shop, its items and who did it.
const openCheckout = ref<HouseholdDetail['recent_checkouts'][number] | null>(null)
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
      v-else-if="!household"
      state="empty"
      title="No such household"
      :message="`Nothing on this database has the id ${householdId}. It may have been deleted, which cascades its lists and history away with it.`"
    >
      <template #action>
        <RouterLink to="/households" class="back">Back to households</RouterLink>
      </template>
    </StateBlock>

    <template v-else>
      <PageHeader
        :title="`${household.emoji ? `${household.emoji} ` : ''}${household.name}`"
        :fetched-at="detail.fetchedAt.value"
        :busy="detail.fetching.value"
        @refresh="detail.refetch"
      />

      <div class="identity">
        <dl class="identity__facts u-facts">
          <div>
            <dt>Owner</dt>
            <dd>
              <RouterLink :to="`/users/${encodeURIComponent(household.created_by)}`" class="identity__link">
                {{ household.owner_name || shortUserId(household.created_by) }}
              </RouterLink>
            </dd>
          </div>
          <div>
            <dt>Invite code</dt>
            <dd><CopyValue :value="household.invite_code" label="invite code" /></dd>
          </div>
          <div>
            <dt>Item cap per member</dt>
            <dd class="u-num">{{ household.max_items_per_member }}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd :title="formatDateTime(household.created_at)">{{ formatRelative(household.created_at) }}</dd>
          </div>
          <div>
            <dt>Last active</dt>
            <dd :title="formatDateTime(household.last_active)">{{ formatRelative(household.last_active) }}</dd>
          </div>
          <div>
            <dt>Household id</dt>
            <dd><CopyValue :value="household.id" :display="`${household.id.slice(0, 8)}…`" label="household id" /></dd>
          </div>
        </dl>
      </div>

      <div class="grid">
        <div class="span-2"><StatTile label="Members" :value="household.members" hint="On the roster" /></div>
        <div class="span-2"><StatTile label="Moderators" :value="household.moderators" hint="Elevated rank" /></div>
        <div class="span-2"><StatTile label="Open items" :value="household.items_open" hint="Unchecked now" /></div>
        <div class="span-2"><StatTile label="Items ever" :value="household.items_total" hint="Added all time" /></div>
        <div class="span-2"><StatTile label="Checkouts" :value="household.checkouts" hint="Completed shops" /></div>
        <div class="span-2"><StatTile label="Products" :value="household.products_added" hint="Contributed rows" /></div>
      </div>

      <div class="grid">
        <div class="span-6">
          <PanelCard title="Members" :note="`${detail.data.value?.members.length ?? 0} on the roster`" fill flush>
            <ul class="rows">
              <li v-for="member in detail.data.value?.members ?? []" :key="member.user_id" class="rows__row">
                <RouterLink :to="`/users/${encodeURIComponent(member.user_id)}`" class="rows__who">
                  <img v-if="member.image_url" class="rows__avatar" :src="member.image_url" alt="" loading="lazy" />
                  <span v-else class="rows__initial" aria-hidden="true">{{ initialOf(member.display_name) }}</span>
                  <span class="u-truncate">{{ member.display_name || shortUserId(member.user_id) }}</span>
                </RouterLink>
                <StatusPill
                  :tone="member.is_owner ? 'accent' : member.role === 'member' ? 'idle' : 'good'"
                  :label="member.is_owner ? 'Owner' : member.role === 'member' ? 'Member' : 'Moderator'"
                  :dot="false"
                />
                <span class="rows__meta u-num" :title="`${member.items_added} items added, ${member.items_open} open`">
                  {{ formatCount(member.items_open) }} / {{ formatCount(member.items_added) }}
                </span>
                <span class="rows__meta u-num">{{ formatCount(member.purchases) }} bought</span>
                <time class="rows__meta" :title="formatDateTime(member.joined_at)">
                  {{ formatRelative(member.joined_at) }}
                </time>
              </li>
            </ul>
          </PanelCard>
        </div>

        <div class="span-6">
          <PanelCard title="Buys most often" note="By how many separate checkouts included it." fill>
            <StateBlock
              v-if="!topProducts.length"
              state="empty"
              title="Nothing bought yet"
              message="This household has never completed a checkout."
              compact
            />
            <BarChart v-else :bars="topProducts" :format="formatCount" dense :limit="10" />
          </PanelCard>
        </div>
      </div>

      <div class="grid">
        <div class="span-7">
          <PanelCard title="Shopping list" flush fill>
            <template #actions>
              <SegmentedControl
                v-model="listFilter"
                :segments="[
                  { value: 'open', label: 'Open' },
                  { value: 'checked', label: 'Checked' },
                  { value: 'all', label: 'All' },
                ]"
                aria-label="List filter"
              />
            </template>

            <StateBlock
              v-if="!listRows.length"
              state="empty"
              :title="listFilter === 'open' ? 'Nothing outstanding' : 'Nothing here'"
              :message="
                listFilter === 'open'
                  ? 'Every item on this list has been checked off, or the list is empty.'
                  : 'No items match this filter.'
              "
              compact
            />
            <ul v-else class="rows">
              <li v-for="item in listRows" :key="item.id" class="rows__row">
                <span class="rows__item u-truncate">
                  <span :class="{ 'rows__struck': item.checked }">{{ item.name }}</span>
                  <span v-if="item.maker" class="rows__maker">{{ item.maker }}</span>
                </span>
                <span class="rows__qty u-num">×{{ item.quantity }}</span>
                <StatusPill :tone="item.checked ? 'good' : 'idle'" :label="item.checked ? 'Checked' : 'Open'" :dot="false" />
                <span class="rows__meta u-truncate">{{ item.added_by_name || shortUserId(item.added_by) }}</span>
                <time class="rows__meta" :title="formatDateTime(item.created_at)">
                  {{ formatRelative(item.created_at) }}
                </time>
              </li>
            </ul>
          </PanelCard>
        </div>

        <div class="span-5">
          <PanelCard title="Recent checkouts" note="One row per shop. Click for what was in it." flush fill>
            <StateBlock
              v-if="!detail.data.value?.recent_checkouts.length"
              state="empty"
              title="No checkouts"
              message="Items have been added but never bought."
              compact
            />
            <ul v-else class="rows">
              <li
                v-for="checkout in detail.data.value.recent_checkouts"
                :key="checkout.checkout_id"
                class="rows__row rows__row--button"
              >
                <button type="button" class="rows__open" @click="openCheckout = checkout">
                  <span class="rows__item">
                    {{ formatCount(checkout.items) }} item{{ checkout.items === 1 ? '' : 's' }}
                    <span class="rows__maker">{{ checkout.purchased_by_name || shortUserId(checkout.purchased_by) }}</span>
                  </span>
                  <time class="rows__meta" :title="formatDateTime(checkout.purchased_at)">
                    {{ formatRelative(checkout.purchased_at) }}
                  </time>
                </button>
              </li>
            </ul>
          </PanelCard>
        </div>
      </div>

      <PanelCard
        v-if="detail.data.value?.contributed_products.length"
        title="Products this household contributed"
        note="Rows in the app database's product_catalog, scoped to this household until three distinct households ask for the same thing."
        flush
      >
        <ul class="rows">
          <li v-for="product in detail.data.value.contributed_products" :key="product.id" class="rows__row">
            <span class="rows__item u-truncate">
              {{ product.name }}
              <span v-if="product.maker" class="rows__maker">{{ product.maker }}</span>
            </span>
            <span v-if="product.barcode" class="rows__meta u-mono">{{ product.barcode }}</span>
            <span class="rows__meta u-num">{{ formatCount(product.add_count) }} adds</span>
            <time class="rows__meta" :title="formatDateTime(product.created_at)">
              {{ formatRelative(product.created_at) }}
            </time>
          </li>
        </ul>
      </PanelCard>

      <p class="foot">
        <button type="button" class="foot__back" @click="router.back()">Back</button>
      </p>

      <SideDrawer
        :open="openCheckout !== null"
        title="Checkout"
        :subtitle="openCheckout ? formatDateTime(openCheckout.purchased_at) : ''"
        @close="openCheckout = null"
      >
        <dl v-if="openCheckout" class="drawer-facts u-facts">
          <div>
            <dt>Bought by</dt>
            <dd>{{ openCheckout.purchased_by_name || shortUserId(openCheckout.purchased_by) }}</dd>
          </div>
          <div>
            <dt>Distinct items</dt>
            <dd class="u-num">{{ formatCount(openCheckout.items) }}</dd>
          </div>
          <div>
            <dt>Total quantity</dt>
            <dd class="u-num">{{ formatCount(openCheckout.quantity) }}</dd>
          </div>
          <div>
            <dt>Checkout id</dt>
            <dd><CopyValue :value="openCheckout.checkout_id" label="checkout id" /></dd>
          </div>
        </dl>

        <p class="drawer-note">
          Purchase history freezes the buyer's name and avatar as they were at the time, so this row
          will not change if they rename themselves later.
        </p>
      </SideDrawer>
    </template>
  </div>
</template>

<style scoped>
.identity {
  background: var(--bg-surface);
  border: var(--border-width-thin) solid var(--border-main);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  box-shadow: var(--elevation-soft);
}

.identity__facts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--space-3);
}

.identity__facts dd {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.identity__link {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: var(--weight-medium);
}

.identity__link:hover {
  text-decoration: underline;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 420px;
  overflow-y: auto;
}

.rows__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: var(--border-width-thin) solid var(--border-light);
}

.rows__row--button {
  padding: 0;
}

.rows__row:last-child {
  border-bottom: none;
}

.rows__open {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-4);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.rows__open:hover {
  background: var(--bg-hover);
}

.rows__who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  text-decoration: none;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.rows__who:hover {
  color: var(--color-primary);
}

.rows__avatar,
.rows__initial {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-pill);
  flex: none;
}

.rows__avatar {
  object-fit: cover;
}

.rows__initial {
  display: grid;
  place-items: center;
  background: var(--color-primary-bg);
  color: var(--color-primary-text);
  font-size: 10px;
  font-weight: var(--weight-bold);
}

.rows__item {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.rows__struck {
  text-decoration: line-through;
  color: var(--text-disabled);
}

.rows__maker {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
}

.rows__qty {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-weight: var(--weight-semibold);
}

.rows__meta {
  font-size: var(--text-2xs);
  color: var(--text-disabled);
  white-space: nowrap;
}

.drawer-facts {
  margin: 0;
  display: grid;
  gap: var(--space-3);
}

.drawer-facts dd {
  margin: 2px 0 0;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.drawer-note {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: var(--leading-normal);
  border-top: var(--border-width-thin) solid var(--border-light);
  padding-top: var(--space-3);
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
