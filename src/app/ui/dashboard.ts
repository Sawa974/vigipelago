import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { I18n } from '../i18n/i18n.service';
import type { Translate } from '../i18n/translate';
import Dexie from 'dexie';
import { ApSessionService } from '../core/ap-session.service';
import { durationLabel } from '../core/duration';
import { usesTwelveHours } from '../select/date-format';
import { db, type ApEvent, type SlotStats } from '../db/db';
import { Dialog } from './dialog';
import { MenuKeys } from './menu-keys';
import { isGoalReached, resolveSlotStatus } from '../ingest/client-status';
import { mergeCoverage, type Interval } from '../ingest/coverage';
import { buildActivity, type ActivityLane } from '../select/activity';
import { goalInstants } from '../select/goals';
import { coverageGaps } from '../select/lanes';
import {
  DEATH_KNOWLEDGE_LABEL,
  buildDeathTally,
  type DeathKnowledge,
  type SlotDeaths,
} from '../select/deaths';
import {
  buildClassTotals,
  buildMultiworldItems,
  buildProgress,
  classSegments,
  countEvents,
  type ClassSegment,
  type ClassTally,
  type MultiworldItems,
  type SlotProgress,
} from '../select/progress';
import {
  itemClassOf,
  ITEM_CLASS_GLYPH,
  ITEM_CLASS_LABEL,
  ITEM_CLASSES,
  type ItemClass,
} from '../protocol/item-class';
import {
  axisSpan,
  buildTimeScale,
  inGap,
  scaleInvert,
  scaleX,
  type TimeScale,
} from '../select/time-scale';
import {
  checksHistogram,
  chooseBucket,
  cumulativeDeathsBySlot,
  cumulativeItemsBySlot,
  type CumulativeResult,
  type HistogramResult,
} from '../select/series';

/** Au-dela, une neuvieme teinte ne serait plus lisible. */
const MAX_COMBINED_SERIES = 8;
const RELOAD_THROTTLE_MS = 15_000;
const DAY_MS = 24 * 3600_000;
const GAP_BAND_PX = 0;
/** En dessous, la seconde de deux graduations voisines est retiree. */
const TICK_MIN_GAP_PX = 34;
/** `09:05 PM` tient environ 46 px a 10 px de corps. */
const TICK_MIN_GAP_12H_PX = 48;
/** Dans l'ordre d'affichage : le choix des colonnes ne reordonne pas. Le nom est toujours la. */
const COMPACT_COLUMNS = [
  { key: 'pct', label: 'st.col.pct', num: true },
  { key: 'checked', label: 'st.checks', num: true },
  { key: 'total', label: 'st.total', num: true },
  { key: 'approx', label: 'st.approx', num: true },
  { key: 'items', label: 'st.itemsReceived', num: true },
  { key: 'progression', label: 'st.cls.progression', num: true },
  { key: 'useful', label: 'st.cls.useful', num: true },
  { key: 'filler', label: 'st.cls.filler', num: true },
  { key: 'trap', label: 'st.cls.trap', num: true },
  { key: 'unknown', label: 'st.cls.unknown', num: true },
  { key: 'game', label: 'st.game', num: false },
  { key: 'deaths', label: 'st.col.deaths', num: true },
] as const;

type CompactKey = (typeof COMPACT_COLUMNS)[number]['key'];

/** Colonnes affichees, le nom compris. */
const COMPACT_MAX_COLUMNS = 5;
const COMPACT_ROW_LIMIT = 10;

/** Duree d'une lecture complete de la frise, en secondes. */
const PLAY_SECONDS = [10, 20, 40, 90] as const;

function byProgress(a: SlotProgress, b: SlotProgress): number {
  return (b.ratio ?? -1) - (a.ratio ?? -1) || b.checked - a.checked;
}

interface Geometry {
  width: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

interface Tick {
  x: number;
  time: string;
  /** Portee seulement par la premiere graduation de chaque journee. */
  date: string | null;
}

interface LinePath {
  slot: number;
  name: string;
  color: string;
  /** Plusieurs sous-chemins : la courbe se rompt dans chaque trou de donnees. */
  d: string;
  endX: number;
  endY: number;
  last: number;
}

interface ColumnSegment {
  cls: string;
  y: number;
  h: number;
}

interface Column {
  x: number;
  w: number;
  value: number;
  covered: number;
  label: string;
  segments: ColumnSegment[];
}

interface GoalMark {
  slot: number;
  x: number;
  /** `null` hors des series tracees : la teinte du texte. */
  color: string | null;
  title: string;
}

interface GapRect {
  x: number;
  w: number;
  title: string;
}

interface ActivityRect {
  x: number;
  w: number;
  title: string;
}

@Component({
  selector: 'app-dashboard',
  imports: [DecimalPipe, Dialog, MenuKeys],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  host: {
    '(document:click)': 'closeSpeedMenu($event)',
    '(document:keydown.escape)': 'speedMenuOpen.set(false)',
  },
})
export class Dashboard {
  protected readonly ap = inject(ApSessionService);
  private readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;
  private readonly host = viewChild<ElementRef<HTMLElement>>('plot');

  protected readonly itemClass = signal<ItemClass | 'all'>('all');
  protected readonly compress = signal(true);

  /* ---------- Curseur de lecture ---------- */

  /** `null` au direct : la fin de la fenetre, qui avance avec les donnees. */
  private readonly cursor = signal<number | null>(null);
  protected readonly playing = signal(false);
  protected readonly playSeconds = signal<number>(PLAY_SECONDS[1]);
  protected readonly playSpeeds = PLAY_SECONDS;
  protected readonly speedMenuOpen = signal(false);

  protected readonly live = computed(() => this.cursor() === null);
  protected readonly cursorAt = computed(() => this.cursor() ?? this.window().to);
  protected readonly cursorLabel = computed(() => this.i18n.datetime(this.cursorAt()));
  /** Hors connexion la fin de la frise n'avance plus : ce n'est pas un direct. */
  protected readonly connected = computed(() => this.ap.state() === 'online');
  protected readonly itemClasses = ITEM_CLASSES;
  protected readonly classLabel = ITEM_CLASS_LABEL;
  protected readonly classGlyph = ITEM_CLASS_GLYPH;
  protected readonly width = signal(900);

  private readonly events = signal<ApEvent[]>([]);
  private readonly stats = signal<Map<number, SlotStats>>(new Map());
  private readonly coverageAll = signal<Interval[]>([]);
  private readonly loadedAt = signal(0);

  /* ---------- Fenetre de temps ---------- */

  protected readonly window = computed<Interval>(() => {
    this.loadedAt();
    const now = Date.now();
    const cov = this.coverageAll();
    const first = cov.length ? cov[0].from : now - 3600_000;
    return { from: first, to: now };
  });

  /**
   * Invariant : ne jamais dependre de `geo()` ni de `scale()`. `needsDateRow` en depend, et le
   * cycle de signaux (« Detected cycle in computations ») vide tout l'onglet.
   */
  private readonly axisSpan = computed(() =>
    axisSpan(this.coverageAll(), this.window(), this.compress()),
  );

  private readonly bucketMs = computed(() => chooseBucket(this.axisSpan()));

  private readonly axisStep = computed(() => chooseBucket(this.axisSpan(), 8));

  /** Comme `axisSpan`, ne doit jamais dependre de la geometrie : `geo()` le lit. */
  private readonly needsDateRow = computed(() => {
    const w = this.window();
    if (this.axisStep() >= DAY_MS) return false;
    return new Date(w.from).toDateString() !== new Date(w.to).toDateString();
  });

  protected readonly geo = computed<Geometry>(() => ({
    width: this.width(),
    // Partagee par tous les graphiques pour qu'ils restent alignes.
    padLeft: 88,
    padRight: 60,
    padTop: 12 + this.markBand(),
    padBottom: this.needsDateRow() ? 38 : 26,
  }));

  protected readonly plotWidth = computed(() => Math.max(80, this.geo().width - this.geo().padLeft - this.geo().padRight));

  /** Tout ce qui est place sur un axe temporel passe par elle. */
  private readonly scale = computed<TimeScale>(() =>
    buildTimeScale({
      coverage: this.coverageAll(),
      window: this.window(),
      left: this.geo().padLeft,
      width: this.plotWidth(),
      compress: this.compress(),
      gapPx: GAP_BAND_PX,
    }),
  );

  private x(t: number): number {
    return scaleX(this.scale(), t);
  }

  private readonly chartEvents = computed<ApEvent[]>(() => {
    const cls = this.itemClass();
    if (cls === 'all') return this.events();
    return this.events().filter((e) => e.kind !== 'item' || itemClassOf(e.itemFlags) === cls);
  });

  protected readonly unclassified = computed(
    () => this.events().filter((e) => e.kind === 'item' && e.itemFlags === null).length,
  );

  /* ---------- Avancement ---------- */

  private readonly cursorEvents = computed<ApEvent[]>(() => {
    if (this.live()) return this.events();
    const t = this.cursorAt();
    return this.events().filter((e) => e.ts <= t);
  });

  /** Ils fixent l'ordre des lignes, que la lecture ne doit pas bouger. */
  private readonly liveCounts = computed(() => countEvents(this.events()));

  private readonly counts = computed(() =>
    this.live() ? this.liveCounts() : countEvents(this.cursorEvents()),
  );

  private readonly liveProgress = computed<SlotProgress[]>(() =>
    buildProgress(this.ap.players(), this.stats(), this.liveCounts(), {
      serverFloor: true,
    }).sort(byProgress),
  );

  /** L'ordre des lignes est celui du direct, jamais celui de l'instant lu. */
  protected readonly progress = computed<SlotProgress[]>(() => {
    if (this.live()) return this.liveProgress();
    const rank = new Map(this.liveProgress().map((p, i) => [p.slot, i]));
    return buildProgress(this.ap.players(), this.stats(), this.counts(), {
      serverFloor: false,
    }).sort((a, b) => (rank.get(a.slot) ?? 0) - (rank.get(b.slot) ?? 0));
  });

  protected readonly multiworld = computed<MultiworldItems>(() =>
    buildMultiworldItems(this.progress(), this.counts()),
  );

  protected readonly cursorX = computed(() => this.x(this.cursorAt()));

  /** En milliemes de la largeur du trace. */
  protected readonly cursorPermil = computed(() => {
    const left = this.geo().padLeft;
    const frac = (this.cursorX() - left) / this.plotWidth();
    return Math.round(Math.min(1, Math.max(0, frac)) * 1000);
  });

  /* ---------- Objectif atteint ---------- */

  /** Declare par le client, jamais calcule : l'absence de declaration ne dit rien. */
  protected readonly goalSlots = computed<Set<number>>(() => {
    const live = this.ap.slotStatus();
    const stored = this.stats();
    const out = new Set<number>();
    for (const p of this.ap.players()) {
      if (isGoalReached(resolveSlotStatus(live, p.slot, stored.get(p.slot)?.status))) {
        out.add(p.slot);
      }
    }
    return out;
  });

  private readonly goalInstants = computed(() => goalInstants(this.events()));

  private readonly goalsInWindow = computed<{ slot: number; ts: number }[]>(() => {
    const w = this.window();
    return [...this.goalInstants()]
      .filter(([, ts]) => ts >= w.from && ts <= w.to)
      .map(([slot, ts]) => ({ slot, ts }));
  });

  /** Sans la geometrie : `geo()` la lit, passer par `x()` fermerait un cycle de signaux. */
  protected readonly markBand = computed(() => (this.goalsInWindow().length ? 18 : 0));

  private readonly seriesColor = computed(
    () => new Map(this.linePaths().map((l) => [l.slot, l.color])),
  );

  protected readonly goalMarks = computed<GoalMark[]>(() => {
    const colors = this.seriesColor();
    const names = new Map(this.ap.players().map((p) => [p.slot, p.name]));
    return this.goalsInWindow()
      .map(({ slot, ts }) => ({
        slot,
        x: this.x(ts),
        color: colors.get(slot) ?? null,
        title: this.t('st.goal.mark', { name: names.get(slot) ?? this.t('name.slot', { slot }), time: this.i18n.datetime(ts) }),
      }))
      .sort((a, b) => a.x - b.x);
  });

  /** Seul endroit ou un objectif atteint sans instant connu reste visible. */
  protected readonly goalBadges = computed<Map<number, { color: string | null; title: string }>>(
    () => {
      const colors = this.seriesColor();
      const instants = this.goalInstants();
      const out = new Map<number, { color: string | null; title: string }>();
      for (const slot of this.goalSlots()) {
        const ts = instants.get(slot);
        out.set(slot, {
          color: colors.get(slot) ?? null,
          title:
            ts === undefined
              ? this.t('st.goal.noTime')
              : this.t('st.goal.at', { time: this.i18n.datetime(ts) }),
        });
      }
      return out;
    },
  );

  /* ---------- Tableau compact ---------- */

  protected readonly compactColumns = COMPACT_COLUMNS;
  protected readonly compactMax = COMPACT_MAX_COLUMNS;
  protected readonly compactRowLimit = COMPACT_ROW_LIMIT;
  protected readonly compactKeys = signal<readonly CompactKey[]>(['pct', 'deaths']);
  protected readonly pickerOpen = signal(false);

  protected readonly compactShown = computed(() =>
    COMPACT_COLUMNS.filter((c) => this.compactKeys().includes(c.key)),
  );

  /** Le nom occupe toujours une colonne. */
  protected readonly compactFull = computed(
    () => this.compactKeys().length >= COMPACT_MAX_COLUMNS - 1,
  );

  protected readonly compactRows = computed(() => {
    const deaths = this.deathBySlot();
    const shown = this.compactShown();
    return this.progress()
      .slice(0, COMPACT_ROW_LIMIT)
      .map((p) => ({
        slot: p.slot,
        name: p.name,
        game: p.game,
        cells: shown.map((c) => ({
          key: c.key,
          num: c.num,
          ...compactCell(c.key, p, deaths.get(p.slot), this.t),
        })),
      }));
  });

  protected readonly compactHidden = computed(() =>
    Math.max(0, this.progress().length - COMPACT_ROW_LIMIT),
  );

  protected isColumnOn(key: CompactKey): boolean {
    return this.compactKeys().includes(key);
  }

  protected toggleColumn(key: CompactKey): void {
    const cur = this.compactKeys();
    if (cur.includes(key)) {
      this.compactKeys.set(cur.filter((k) => k !== key));
      return;
    }
    if (this.compactFull()) return;
    this.compactKeys.set([...cur, key]);
  }

  /* ---------- Bande de couverture ---------- */

  /** Rien en compresse : avec `GAP_BAND_PX` a zero, il ne resterait qu'un trait invisible. */
  protected readonly gaps = computed<GapRect[]>(() =>
    this.compress()
      ? []
      : coverageGaps(this.coverageAll(), this.window()).map((g) => ({
          x: this.x(g.from),
          w: Math.max(1, this.x(g.to) - this.x(g.from)),
          title: this.t('st.gap', {
            from: this.i18n.datetime(g.from),
            to: this.i18n.datetime(g.to),
            duration: durationLabel(g.to - g.from, this.t),
          }),
        })),
  );

  protected readonly ticks = computed<Tick[]>(() => {
    const w = this.window();
    const step = this.axisStep();
    const sc = this.scale();
    // La regle de la place reservee sous l'axe, sinon la date sort du graphique.
    const dated = this.needsDateRow();
    const out: Tick[] = [];
    let lastDay = '';
    let lastX = -Infinity;
    const gapPx = usesTwelveHours(this.i18n.dateStyle()) ? TICK_MIN_GAP_12H_PX : TICK_MIN_GAP_PX;

    for (let t = Math.ceil(w.from / step) * step; t < w.to; t += step) {
      if (inGap(sc, t)) continue;
      const x = this.x(t);
      if (x - lastX < gapPx) continue;
      const day = this.i18n.day(t);
      if (step >= DAY_MS) {
        out.push({ x, time: day, date: null });
      } else {
        out.push({ x, time: this.i18n.clock(t), date: dated && day !== lastDay ? day : null });
      }
      lastDay = day;
      lastX = x;
    }
    return out;
  });

  /* ---------- Lignes par joueur ---------- */

  protected readonly laneHeight = 16;
  protected readonly laneGap = 6;

  protected readonly classTotals = computed(() => buildClassTotals(this.counts()));

  protected readonly classTotalSegments = computed(() => {
    const t = this.classTotals();
    return this.classSegments(t.byClass);
  });

  /** Le total n'est pas la somme par joueur : une mort sans slot reste comptee. */
  protected readonly deaths = computed(() =>
    buildDeathTally({
      events: this.events(),
      slots: this.ap.players().map((p) => p.slot),
    }),
  );

  protected readonly deathRows = computed(() => {
    const names = new Map(this.ap.players().map((p) => [p.slot, p.name]));
    return this.deaths()
      .bySlot.map((d) => ({
        ...d,
        name: names.get(d.slot) ?? this.t('name.slot', { slot: d.slot }),
        why: this.t(DEATH_KNOWLEDGE_LABEL[d.knowledge]),
      }))
      .sort(
        (a, b) =>
          Number(a.count === null) - Number(b.count === null) ||
          (b.count ?? 0) - (a.count ?? 0) ||
          a.name.localeCompare(b.name),
      );
  });

  protected classSegments(t: ClassTally): ClassSegment[] {
    return classSegments(t, this.t);
  }

  protected deathWhy(k: DeathKnowledge): string {
    return this.t(DEATH_KNOWLEDGE_LABEL[k]);
  }

  /* ---------- Activite reelle ---------- */

  private readonly activity = computed<ActivityLane[]>(() =>
    buildActivity(this.events(), this.ap.players().map((p) => p.slot), this.window()),
  );

  protected readonly activityLanes = computed<
    { slot: number; name: string; checks: number; unplaced: number; y: number; rects: ActivityRect[] }[]
  >(() => {
    const players = this.ap.players();
    const top = this.markBand();
    return this.activity().map((lane, i) => ({
      slot: lane.slot,
      y: top + i * (this.laneHeight + this.laneGap),
      name: players[i]?.name ?? this.t('name.slot', { slot: lane.slot }),
      checks: lane.checks,
      unplaced: lane.unplaced,
      rects: lane.runs.map((r) => ({
        x: this.x(r.from),
        // Une plage de duree nulle reste visible.
        w: Math.max(2, this.x(r.to) - this.x(r.from)),
        title:
          this.t('st.run', { name: players[i]?.name ?? '', duration: durationLabel(r.to - r.from, this.t), count: r.checks }) +
          `\n${this.i18n.datetime(r.from)} → ${this.i18n.datetime(r.to)}`,
      })),
    }));
  });

  protected readonly activityHeight = computed(
    () =>
      this.markBand() +
      this.ap.players().length * (this.laneHeight + this.laneGap) +
      this.geo().padBottom,
  );

  protected readonly unplacedActivity = computed(() =>
    this.activity().reduce((s, l) => s + l.unplaced, 0),
  );

  /* ---------- Courbe cumulative ---------- */

  protected readonly plotHeight = 200;

  private readonly cumulative = computed<CumulativeResult>(() => {
    const w = this.window();
    return cumulativeItemsBySlot(
      this.chartEvents(),
      this.ap.players().map((p) => p.slot),
      { ...w, bucketMs: this.bucketMs() },
      this.coverageAll(),
    );
  });

  /** Rendus dans l'ordre des slots, jamais du rang : la teinte suit le joueur. */
  private readonly displayedSlots = computed<number[]>(() => {
    const cum = this.cumulative();
    if (cum.series.length <= MAX_COMBINED_SERIES) return cum.series.map((s) => s.slot);
    return [...cum.series]
      .sort((a, b) => b.last - a.last)
      .slice(0, MAX_COMBINED_SERIES)
      .map((s) => s.slot)
      .sort((a, b) => a - b);
  });

  protected readonly hiddenSeriesCount = computed(
    () => this.cumulative().series.length - this.displayedSlots().length,
  );

  private cumulativePaths(
    cum: CumulativeResult,
    shown: readonly number[],
    colorOf: (slot: number, index: number) => string,
  ): LinePath[] {
    const bySlot = new Map(this.ap.players().map((p) => [p.slot, p.name]));
    const h = this.plotHeight;
    const top = this.geo().padTop;
    const yMax = Math.max(1, cum.max);
    const step = this.bucketMs();

    return shown.map((slot, index) => {
      const s = cum.series.find((x) => x.slot === slot)!;
      const parts: string[] = [];
      let open = false;
      let endX = this.geo().padLeft;
      let endY = top + h;
      s.points.forEach((v, idx) => {
        if (v === null) {
          // On ne relie pas au-dessus d'un trou de donnees.
          open = false;
          return;
        }
        const px = this.x(cum.starts[idx] + step);
        const py = top + h - (v / yMax) * h;
        parts.push(`${open ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`);
        open = true;
        endX = px;
        endY = py;
      });
      return {
        slot,
        name: bySlot.get(slot) ?? this.t('name.slot', { slot }),
        color: colorOf(slot, index),
        d: parts.join(' '),
        endX,
        endY,
        last: s.last,
      };
    });
  }

  protected readonly linePaths = computed<LinePath[]>(() =>
    this.cumulativePaths(
      this.cumulative(),
      this.displayedSlots(),
      (_slot, i) => `var(--series-${i + 1})`,
    ),
  );

  protected readonly directLabels = computed(() =>
    this.linePaths().length <= 4 ? this.linePaths() : [],
  );

  private cumulativeYTicks(rawMax: number): { y: number; label: string }[] {
    const max = Math.max(1, rawMax);
    const step = niceStep(max);
    const out: { y: number; label: string }[] = [];
    for (let v = 0; v <= max; v += step) {
      out.push({
        y: this.geo().padTop + this.plotHeight - (v / max) * this.plotHeight,
        label: v.toLocaleString(this.i18n.lang()),
      });
    }
    return out;
  }

  protected readonly yTicks = computed(() => this.cumulativeYTicks(this.cumulative().max));

  /* ---------- Courbe des morts ---------- */

  private readonly deathCumulative = computed<CumulativeResult>(() =>
    cumulativeDeathsBySlot(
      this.events(),
      this.ap.players().map((p) => p.slot),
      { ...this.window(), bucketMs: this.bucketMs() },
      this.coverageAll(),
    ),
  );

  private readonly deathSlots = computed<number[]>(() =>
    [...this.deathCumulative().series]
      .filter((s) => s.last > 0)
      .sort((a, b) => b.last - a.last)
      .slice(0, MAX_COMBINED_SERIES)
      .map((s) => s.slot)
      .sort((a, b) => a - b),
  );

  protected readonly deathPaths = computed<LinePath[]>(() =>
    this.cumulativePaths(this.deathCumulative(), this.deathSlots(), (slot) =>
      // La teinte de la courbe des objets : un joueur garde sa couleur d'un graphique a l'autre.
      this.seriesColor().get(slot) ?? 'var(--text)',
    ),
  );

  protected readonly deathLabels = computed(() =>
    this.deathPaths().length <= 4 ? this.deathPaths() : [],
  );

  protected readonly deathYTicks = computed(() =>
    this.cumulativeYTicks(this.deathCumulative().max),
  );

  protected readonly deathBySlot = computed(
    () => new Map(this.deaths().bySlot.map((d) => [d.slot, d])),
  );

  /** Faux ne veut pas dire que personne ne l'a active : seuls les tags vus passer comptent. */
  protected readonly anyDeathLink = computed(() =>
    this.deaths().bySlot.some(
      (d) => d.knowledge === 'observed' || d.knowledge === 'tagged-silent',
    ),
  );

  /* ---------- Histogramme des checks ---------- */

  private readonly histogram = computed<HistogramResult>(() =>
    checksHistogram(this.events(), { ...this.window(), bucketMs: this.bucketMs() }, this.coverageAll()),
  );

  protected readonly unplacedChecks = computed(() => this.histogram().unplaced);
  protected readonly placedChecks = computed(() => this.histogram().placed);

  protected readonly histHeight = 120;

  protected readonly columns = computed<Column[]>(() => {
    const h = this.histogram();
    const top = this.geo().padTop;
    const height = this.histHeight;
    const max = Math.max(1, h.max);
    const sc = this.scale();
    const step = this.bucketMs();
    // La progression est ancree a la ligne de base.
    const order: (ItemClass | 'unknown')[] = ['progression', 'useful', 'filler', 'trap', 'unknown'];

    return h.buckets.flatMap((b) => {
      // Sinon sa cible de survol irait se tasser dans la coupure.
      if (inGap(sc, b.t) && inGap(sc, b.t + step)) return [];
      // Compressee, l'echelle donne des largeurs differentes a deux tranches voisines.
      const band = Math.max(1, this.x(b.t + step) - this.x(b.t));
      const w = Math.max(1, Math.min(24, band - 2));
      const segments: ColumnSegment[] = [];
      let cursor = top + height;
      for (const cls of order) {
        const n = b.byClass[cls];
        if (!n) continue;
        const raw = (n / max) * height;
        cursor -= raw;
        segments.push({ cls: `f-${cls}`, y: cursor, h: Math.max(1, raw - 2) });
      }
      const detail = order
        .filter((c) => b.byClass[c] > 0)
        .map((c) => this.t('itemClass.tally', { label: this.t(c === 'unknown' ? 'itemClass.unknown' : ITEM_CLASS_LABEL[c]), count: b.byClass[c] }))
        .join(', ');
      return [{
        x: this.x(b.t) + (band - w) / 2,
        w,
        value: b.value,
        covered: b.covered,
        label:
          this.t('st.slice', { time: this.i18n.datetime(b.t), count: b.value }) +
          (detail ? ` (${detail})` : '') +
          (b.covered < 1 ? ` · ${this.t('st.slice.covered', { pct: Math.round(b.covered * 100) })}` : ''),
        segments,
      }];
    });
  });

  protected readonly histMax = computed(() => Math.max(1, this.histogram().max));

  private frame = 0;
  private lastFrame = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(this.frame);
      if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    });

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 900;
      if (Math.abs(w - this.width()) > 4) this.width.set(Math.round(w));
    });
    effect((onCleanup) => {
      const el = this.host()?.nativeElement;
      if (!el) return;
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    });

    // `untracked` : `reload()` ecrit `loadedAt`, le suivre relancerait l'effet toutes les 15 s.
    // Le minuteur en attente ne se remplace pas : sinon un flux continu repousse le rechargement.
    effect(() => {
      this.ap.eventCount();
      if (this.reloadTimer !== null) return;
      const since = Date.now() - untracked(() => this.loadedAt());
      if (since >= RELOAD_THROTTLE_MS) {
        void this.reload();
        return;
      }
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        void this.reload();
      }, RELOAD_THROTTLE_MS - since);
    });

    // Un balayage ecrit `slotStats` sans bouger `eventCount`.
    effect(() => {
      if (this.ap.sweep()?.running === false) void untracked(() => this.reload());
    });
  }

  protected onScrub(e: Event): void {
    const permil = Number((e.target as HTMLInputElement).value);
    const px = this.geo().padLeft + (permil / 1000) * this.plotWidth();
    this.seek(px);
  }

  protected pickSpeed(sp: number): void {
    this.playSeconds.set(sp);
    this.speedMenuOpen.set(false);
  }

  protected closeSpeedMenu(e: MouseEvent): void {
    if (!this.speedMenuOpen()) return;
    if ((e.target as Element | null)?.closest('.transport')) return;
    this.speedMenuOpen.set(false);
  }

  protected toLive(): void {
    this.stopPlay();
    this.cursor.set(null);
  }

  protected togglePlay(): void {
    if (this.playing()) {
      this.stopPlay();
      return;
    }
    if (this.live()) this.cursor.set(this.scale().segs[0].from);
    this.playing.set(true);
    this.lastFrame = performance.now();
    this.frame = requestAnimationFrame((t) => this.step(t));
  }

  /** Avance en pixels, pas en millisecondes : une longue pause se franchit d'un coup. */
  private step(now: number): void {
    if (!this.playing()) return;
    const left = this.geo().padLeft;
    const width = this.plotWidth();
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const px = this.cursorX() + (width / this.playSeconds()) * dt;
    if (px >= left + width) {
      this.toLive();
      return;
    }
    this.seek(px);
    this.frame = requestAnimationFrame((t) => this.step(t));
  }

  private seek(px: number): void {
    const t = scaleInvert(this.scale(), px);
    this.cursor.set(t >= this.window().to ? null : t);
  }

  private stopPlay(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.frame);
  }

  protected toggleCompress(e: Event): void {
    this.compress.set((e.target as HTMLInputElement).checked);
  }

  private async reload(): Promise<void> {
    const roomId = this.ap.roomId();
    if (!roomId) return;
    const [events, statRows, sessions] = await Promise.all([
      db.events
        .where('[roomId+ts]')
        .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
        .toArray(),
      db.slotStats.where('roomId').equals(roomId).toArray(),
      db.sessions.where('roomId').equals(roomId).toArray(),
    ]);
    this.events.set(events);
    this.stats.set(new Map(statRows.map((r) => [r.slot, r])));
    this.coverageAll.set(mergeCoverage(sessions, Date.now()));
    this.loadedAt.set(Date.now());
  }
}

/** `—` et un `title` qui dit pourquoi la ou le chiffre manque : un manque n'est pas un zero. */
function compactCell(
  key: CompactKey,
  p: SlotProgress,
  d: SlotDeaths | undefined,
  t: Translate,
): { text: string; title: string } {
  const plain = (n: number) => ({ text: String(n), title: '' });
  switch (key) {
    case 'pct':
      return p.ratio === null
        ? { text: '—', title: t('st.cell.noTotal') }
        : { text: `${(p.ratio * 100).toFixed(0)} %`, title: '' };
    case 'deaths':
      if (!d || d.count === null) {
        return { text: '—', title: d ? t(DEATH_KNOWLEDGE_LABEL[d.knowledge]) : '' };
      }
      return plain(d.count);
    case 'checked':
      return plain(p.checked);
    case 'total':
      return p.total === null
        ? { text: '—', title: t('st.cell.never') }
        : plain(p.total);
    case 'approx':
      return plain(p.approx);
    case 'items':
      return plain(p.itemsReceived);
    case 'game':
      return { text: p.game, title: p.game };
    default:
      return plain(p.byClass[key]);
  }
}

/** Pas d'axe rond : 1, 2, 5, 10, 20, 50... */
function niceStep(max: number): number {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / mag;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, mult * mag);
}
