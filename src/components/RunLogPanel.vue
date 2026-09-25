<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PanelCard from './PanelCard.vue'
import StateBlock from './StateBlock.vue'
import { fetchRunLogs, subscribeRunLogs, LOG_PAGE, type RunLogLine } from '../lib/data/runLogs'
import { describeError } from '../lib/useQuery'

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
const level = ref<'all' | 'warn' | 'error'>('all')
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
      <label class="control">
        Show
        <select v-model="level">
          <option value="all">Everything</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors</option>
        </select>
      </label>
      <label class="control"><input v-model="follow" type="checkbox" /> Follow</label>
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
.control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
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
