<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import UserChip from '../components/UserChip.vue'
import PageHeader from '../components/PageHeader.vue'
import PanelCard from '../components/PanelCard.vue'
import StatTile from '../components/StatTile.vue'
import StateBlock from '../components/StateBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import BarChart from '../components/BarChart.vue'
import CopyValue from '../components/CopyValue.vue'
import SideDrawer from '../components/SideDrawer.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { useQuery, describeError } from '../lib/useQuery'
import { crumbOf, useLeafCrumb } from '../lib/breadcrumb'
import {
  deleteHousehold,
  fetchHouseholdDetail,
  restoreHousehold,
  type HouseholdDetail,
} from '../lib/data/households'
import { formatCount, formatDateTime, formatRelative } from '../lib/format'

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

// ─── withdrawing it, and putting it back ─────────────────────────────────────
//
// Soft: the RPC sets deleted_at and the database hides everything inside the
// household through active_household_ids(). It reappears under Bans, and nothing
// is destroyed.
//
// This page opens a withdrawn household rather than refusing it, which is the
// whole point of a reversible delete: the decision to restore is made by looking
// at what is inside, and until admin_household_facts() carried deleted_at
// instead of filtering on it, every route here -- a member's profile, the Bans
// row offering the restore -- landed on "No such household".
//
// So the page has two states and one button, and the button is the way out of
// whichever state it is in.
const withdrawn = computed(() => Boolean(household.value?.deleted_at))

const confirming = ref(false)
const working = ref(false)
const actionError = ref('')

async function confirmReversal() {
  if (working.value) return
  working.value = true
  actionError.value = ''
  try {
    const signal = new AbortController().signal
    if (withdrawn.value) {
      await restoreHousehold(householdId.value, signal)
    } else {
      await deleteHousehold(householdId.value, signal)
    }
    confirming.value = false
    // Stay, and read the row back.
    //
    // The delete used to push to /households, because the page could not render
    // what it had just done and would have shown its own "no such household"
    // state -- which reads as the delete having failed. It can render it now,
    // so staying is the honest ending: the same page, marked Withdrawn, with
    // the way back on it.
    await detail.refetch()
  } catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    working.value = false
  }
}
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
      >
        <template #tools>
          <StatusPill
            v-if="withdrawn"
            tone="bad"
            label="Withdrawn"
            :title="`Withdrawn ${formatDateTime(household.deleted_at as string)}`"
          />
          <button
            type="button"
            class="u-btn"
            :class="{ 'u-btn--danger': !withdrawn }"
            @click="confirming = true"
          >
            {{ withdrawn ? 'Restore' : 'Delete' }}
          </button>
        </template>
      </PageHeader>

      <div class="identity">
        <dl class="identity__facts u-facts">
          <div>
            <dt>Owner</dt>
            <dd>
              <UserChip
                :id="household.created_by"
                :name="household.owner_name"
                :src="household.owner_image_url"
                :size="20"
              />
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
                <UserChip
                  class="rows__who"
                  :id="member.user_id"
                  :name="member.display_name"
                  :src="member.image_url"
                />
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
                <UserChip
                  class="rows__meta"
                  :id="item.added_by"
                  :name="item.added_by_name"
                  :src="item.added_by_image_url"
                  :size="18"
                />
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
                    <!-- Unlinked, and it has to be: the row is a <button>, and a
                         link nested inside one is not something the browser can
                         resolve. The drawer this opens carries the linked chip. -->
                    <UserChip
                      class="rows__maker"
                      :id="checkout.purchased_by"
                      :name="checkout.purchased_by_name"
                      :src="checkout.purchased_by_image_url"
                      :size="18"
                      :link="false"
                    />
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
            <UserChip
              v-if="product.contributed_by"
              class="rows__meta"
              :id="product.contributed_by"
              :name="product.contributed_by_name"
              :src="product.contributed_by_image_url"
              :size="18"
            />
            <span class="rows__meta u-num">
              {{ formatCount(product.add_count) }} add{{ product.add_count === 1 ? '' : 's' }}
            </span>
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
            <dd>
              <UserChip
                :id="openCheckout.purchased_by"
                :name="openCheckout.purchased_by_name"
                :src="openCheckout.purchased_by_image_url"
                :size="20"
              />
            </dd>
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

    <ConfirmDialog
      :open="confirming"
      :title="
        withdrawn
          ? `Restore ${household?.name ?? 'this household'}?`
          : `Delete ${household?.name ?? 'this household'}?`
      "
      :message="
        withdrawn
          ? 'Its members get it back exactly as they left it. Nothing was destroyed, so nothing has to be rebuilt.'
          : 'Its members lose access to it and everything inside it. Nothing is destroyed — it moves to Bans and can be restored.'
      "
      :confirm-label="withdrawn ? 'Restore' : 'Delete'"
      :tone="withdrawn ? 'primary' : 'danger'"
      :busy="working"
      :error="actionError"
      @confirm="confirmReversal"
      @cancel="confirming = false"
    />
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

/* Only what the chip cannot know: how much of the row it may take. */
.rows__who {
  flex: 1;
  font-size: var(--text-sm);
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

/* The row aligns its texts on a shared baseline, which is right for a name at
   --text-sm beside a maker at --text-2xs. A chip has no baseline worth sharing
   -- it would offer up the bottom edge of its avatar -- so it centres instead,
   which is how a face beside a line of text should sit anyway. */
.rows__item > .chip {
  align-self: center;
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
