<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PanelCard from './PanelCard.vue'
import StateBlock from './StateBlock.vue'
import SegmentedControl from './SegmentedControl.vue'
import { fetchRunLogs, subscribeRunLogs, LOG_PAGE, type RunLogLine } from '../lib/data/runLogs'
import { describeError } from '../lib/useQuery'
import type { Segment } from '../lib/uiTypes'

// What a run said while it ran (catalog 023), live while it is running.
//
// TWO ROADS IN, ONE LIST. Realtime delivers each line as the scraper ships it;
// a poll every 30 seconds asks for everything after the last id seen, so a
// socket that never joined costs half a minute rather than the whole log. A
// line that comes down both roads is drawn once: `seen` is keyed by id.
//
// THE POLL KEEPS ITS OWN CURSOR. Realtime can hand over line 521 before the
// socket saw 501-520 (a join that took a second, a reconnect: postgres_changes
// replays nothing). If 521 moved the cursor, the poll would ask for "after
// 521" and those twenty lines would never be drawn. So only what the poll
// itself read advances `polledUpTo`; Realtime lines only fill `seen`.

const props = defineProps<{ runId: string; live: boolean }>()

const POLL_MS = 30_000

const lines = ref<RunLogLine[]>([])
const seen = new Set<number>()
const loading = ref(true)
const error = ref('')
const more = ref(false)
const level = ref<string>('all')
const levels: Segment[] = [
  { value: 'all', label: 'All' },
  { value: 'warn', label: 'Warnings', title: 'Warnings and errors' },
  { value: 'error', label: 'Errors' },
]
const follow = ref(true)
const box = ref<HTMLElement | null>(null)

let polledUpTo = 0
const lastId = () => (lines.value.length ? lines.value[lines.value.length - 1].id : 0)

function take(incoming: RunLogLine[]) {
  let outOfOrder = false
  for (const line of incoming) {
    if (seen.has(line.id)) continue
    seen.add(line.id)
    if (lines.value.length && line.id < lastId()) outOfOrder = true
    lines.value.push(line)
  }
  if (outOfOrder) lines.value.sort((a, b) => a.id - b.id)
  if (follow.value) void nextTick(() => box.value?.scrollTo?.({ top: box.value.scrollHeight }))
}

async function load() {
  try {
    const page = await fetchRunLogs(props.runId, polledUpTo, new AbortController().signal)
    if (page.length) polledUpTo = page[page.length - 1].id
    take(page)
    more.value = page.length === LOG_PAGE
    error.value = ''
  } catch (caught) {
    error.value = describeError(caught instanceof Error ? caught : new Error(String(caught))).detail
  } finally {
    loading.value = false
  }
}

let stop: (() => void) | null = null
let timer: ReturnType<typeof setInterval> | null = null

function goLive() {
  if (stop) return
  stop = subscribeRunLogs(props.runId, (line) => take([line]))
  timer = setInterval(() => {
    // A tab in the background has nobody reading it.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void load()
  }, POLL_MS)
}

function stopLive() {
  stop?.()
  stop = null
  if (timer) clearInterval(timer)
  timer = null
}

onMounted(async () => {
  await load()
  if (props.live) goLive()
})

// The run closed while the page was open: one last read for the closing lines,
// then stop listening.
watch(
  () => props.live,
  (live) => {
    if (live) {
      goLive()
    } else {
      stopLive()
      void load()
    }
  },
)
onBeforeUnmount(stopLive)

// Stop following once the reader scrolls up to read something; follow again
// when they come back to the bottom.
function onScroll() {
  const el = box.value
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

const shown = computed(() =>
  level.value === 'all'
    ? lines.value
    : lines.value.filter((l) => l.level === 'error' || (level.value === 'warn' && l.level === 'warn')),
)

const clock = (t: string) => new Date(t).toLocaleTimeString('en-GB', { hour12: false })
</script>

<template>
  <PanelCard
    title="Log"
    :note="live ? 'Live: new lines appear as the scraper sends them.' : 'Everything the scraper said.'"
    flush
  >
    <template #actions>
      <SegmentedControl v-model="level" :segments="levels" aria-label="Which lines" />
      <!-- A toggle, so a pressed button rather than a checkbox: it matches the
           segments beside it, and aria-pressed says the state. -->
      <button
        type="button"
        class="u-btn log__follow"
        :aria-pressed="follow"
        title="Keep the newest line in view"
        @click="follow = !follow"
      >
        <span class="log__follow-dot" aria-hidden="true"></span>
        Follow
      </button>
    </template>

    <!-- Above the lines, not instead of them: one failed poll must not take a
         log that is already on screen away. -->
    <StateBlock v-if="error" state="error" title="Could not read the log" :message="error" compact />
    <StateBlock v-if="loading" state="loading" title="Reading the log" />
    <StateBlock
      v-else-if="!lines.length && !live && !error"
      state="empty"
      title="No log for this run"
      message="Runs from before the log was kept have none. A run from now on keeps every line for 30 days."
    />
    <div v-else ref="box" class="log" role="log" @scroll="onScroll">
      <details v-for="line in shown" :key="line.id" class="log__line" :class="`log__line--${line.level}`">
        <summary>
          <time class="u-num" :datetime="line.t">{{ clock(line.t) }}</time>
          <span class="log__level">{{ line.level }}</span>
          <span class="log__message">{{ line.message }}</span>
        </summary>
        <pre v-if="line.fields">{{ JSON.stringify(line.fields, null, 2) }}</pre>
      </details>
      <p v-if="live && !lines.length" class="log__wait">Waiting for the first line.</p>
      <button v-if="more" type="button" class="log__more" @click="load">Load more</button>
    </div>
  </PanelCard>
</template>

<style scoped>
.log__follow[aria-pressed='true'] {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.log__follow-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-main);
}

.log__follow[aria-pressed='true'] .log__follow-dot {
  background: var(--color-primary);
}

.log {
  max-height: 32rem;
  overflow: auto;
  padding: var(--space-2) 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--text-xs);
}

.log__line summary {
  display: flex;
  gap: var(--space-2);
  padding: 2px var(--space-4);
  cursor: pointer;
  list-style: none;
}

.log__line summary::-webkit-details-marker {
  display: none;
}

.log__line summary:hover {
  background: var(--border-light);
}

.log__level {
  min-width: 3.5rem;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.log__line--warn .log__level {
  color: var(--status-warn);
}

.log__line--error .log__level,
.log__line--error .log__message {
  color: var(--status-bad);
}

.log__message {
  overflow-wrap: anywhere;
}

/* A line with nothing to unfold should not look like it has. */
.log__line:not(:has(pre)) summary {
  cursor: default;
}

.log__line pre {
  margin: 0 var(--space-4) var(--space-2) calc(var(--space-4) + 9rem);
  white-space: pre-wrap;
  color: var(--text-secondary);
}

.log__wait,
.log__more {
  margin: var(--space-2) var(--space-4);
}
</style>
