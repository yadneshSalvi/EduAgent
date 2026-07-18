'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TrendingDown } from 'lucide-react';
import type { DashboardData } from '@eduagent/shared';
import {
  buildDecayChart,
  formatShortDate,
  projKey,
  tickDates,
  type DecayChartRow,
} from '@/lib/dashboard-data';
import { formatMastery } from '@/lib/mastery';

/**
 * Forgetting curves (plans/04 §4, 05 §7): solid past, dotted 14-day
 * projection, commit-boost up-arrows on the line, hover = vertical guide +
 * card. One accent family: series colors come from the mastery ramp +
 * --accent; grid lines --border; ≤4 ticks, 13px muted, dates "Jul 12".
 */
const SERIES_COLORS = ['#7C6AEF', '#3ECF8E', '#2F6F8F', '#2E9E7A', '#8B93A7', '#3B4C6B'];

const CHART_HEIGHT = 260;
/** Approximate plot height for end-label collision nudging. */
const PLOT_HEIGHT = CHART_HEIGHT - 12 - 24 - 26;
const LABEL_MIN_GAP = 17;
/** Labels may hang slightly below the plot, never into the axis dates. */
const LABEL_MAX_Y = PLOT_HEIGHT + 6;
const LABEL_MAX_CHARS = 20;

interface EndLabel {
  concept: string;
  name: string;
  color: string;
  /** Vertical nudge (px) so close line endings don't overlap. */
  dy: number;
}

/** Stacks end-of-line labels: sorted by final value, pushed apart ≥15px. */
function layoutEndLabels(
  concepts: Array<{ concept: string; name: string }>,
  rows: DecayChartRow[],
  colorOf: (concept: string) => string,
): Map<string, EndLabel> {
  const finals = concepts.map(({ concept, name }) => {
    let value = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i]![projKey(concept)] ?? rows[i]![concept];
      if (typeof v === 'number') {
        value = v;
        break;
      }
    }
    return { concept, name, value };
  });
  finals.sort((a, b) => b.value - a.value);
  // Forward pass pushes overlapping labels down; the backward pass then
  // clamps the stack to the plot bottom so low-value series never collide
  // with each other or the axis dates.
  const ys: number[] = [];
  let lastY = -Infinity;
  for (const { value } of finals) {
    const naturalY = (1 - value) * PLOT_HEIGHT;
    lastY = Math.max(naturalY, lastY + LABEL_MIN_GAP);
    ys.push(lastY);
  }
  for (let i = finals.length - 1; i >= 0; i--) {
    const cap = i === finals.length - 1 ? LABEL_MAX_Y : ys[i + 1]! - LABEL_MIN_GAP;
    if (ys[i]! > cap) ys[i] = cap;
  }
  const labels = new Map<string, EndLabel>();
  finals.forEach(({ concept, name, value }, i) => {
    const naturalY = (1 - value) * PLOT_HEIGHT;
    labels.set(concept, { concept, name, color: colorOf(concept), dy: ys[i]! - naturalY });
  });
  return labels;
}

interface TooltipRow {
  dataKey?: string | number;
  value?: number | string | Array<number | string>;
}

function HoverCard({
  active,
  label,
  payload,
  names,
  colors,
}: {
  active?: boolean;
  label?: string | number;
  payload?: TooltipRow[];
  names: Map<string, string>;
  colors: Map<string, string>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  // Past + projection share the today point — dedupe to one row per concept.
  const seen = new Map<string, number>();
  for (const row of payload) {
    const key = String(row.dataKey ?? '');
    const concept = key.endsWith(':proj') ? key.slice(0, -5) : key;
    if (typeof row.value === 'number' && !seen.has(concept)) seen.set(concept, row.value);
  }
  return (
    <div className="rounded-md border bg-popover px-3 py-2.5 shadow-overlay">
      <p className="font-mono text-caption text-muted-foreground">
        {formatShortDate(String(label ?? ''))}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {[...seen.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([concept, value]) => (
            <li key={concept} className="flex items-center gap-2 text-caption">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: colors.get(concept) }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {names.get(concept) ?? concept}
              </span>
              <span className="numeric font-mono">{formatMastery(value)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

export function DecayChart({
  decaySeries,
  today,
}: {
  decaySeries: DashboardData['decaySeries'];
  today: string;
}) {
  const { rows, concepts, boosts } = useMemo(
    () => buildDecayChart(decaySeries, today),
    [decaySeries, today],
  );
  const colors = useMemo(
    () =>
      new Map(concepts.map((c, i) => [c.concept, SERIES_COLORS[i % SERIES_COLORS.length]!])),
    [concepts],
  );
  const colorOf = (concept: string) => colors.get(concept) ?? SERIES_COLORS[0]!;
  const endLabels = useMemo(
    () => layoutEndLabels(concepts, rows, (concept) => colors.get(concept) ?? SERIES_COLORS[0]!),
    [concepts, rows, colors],
  );
  const names = new Map(concepts.map((c) => [c.concept, c.name]));

  if (rows.length === 0) {
    return (
      <section aria-label="Forgetting curves" className="flex flex-col rounded-lg border bg-surface p-6">
        <h2 className="text-lead font-medium">Forgetting curves</h2>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
          <TrendingDown className="size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-body-sm text-muted-foreground">
            No history yet — your first session will plant this chart.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Forgetting curves" className="flex flex-col gap-4 rounded-lg border bg-surface p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lead font-medium">Forgetting curves</h2>
        <p className="font-mono text-caption text-muted-foreground">
          solid = history · dotted = 14d projection · ↑ = commit boost
        </p>
      </header>

      <div style={{ height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 12, right: 128, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="date"
              ticks={tickDates(rows)}
              tickFormatter={formatShortDate}
              tick={{ fontSize: 13, fill: 'var(--text-muted)' }}
              axisLine={{ stroke: 'var(--border)' }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.5, 1]}
              tick={{ fontSize: 13, fill: 'var(--text-muted)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              content={<HoverCard names={names} colors={colors} />}
            />
            {concepts.map(({ concept, name }) => {
              const color = colorOf(concept);
              const label = endLabels.get(concept);
              return [
                <Line
                  key={concept}
                  dataKey={concept}
                  stroke={color}
                  strokeWidth={2}
                  isAnimationActive={false}
                  connectNulls
                  dot={(props: unknown) => {
                    const { key, cx, cy, payload } = props as {
                      key?: React.Key;
                      cx?: number;
                      cy?: number;
                      payload?: DecayChartRow;
                    };
                    if (
                      cx === undefined ||
                      cy === undefined ||
                      !payload ||
                      !boosts.has(`${concept}:${payload.date as string}`)
                    ) {
                      return <g key={key} />;
                    }
                    // Commit boost: small up-arrow on the line (05 §7).
                    return (
                      <g key={key} transform={`translate(${cx},${cy})`}>
                        <path
                          d="M 0 -4 L 4 2 L -4 2 Z"
                          fill={color}
                          stroke="var(--surface)"
                          strokeWidth={0.75}
                        />
                      </g>
                    );
                  }}
                />,
                <Line
                  key={projKey(concept)}
                  dataKey={projKey(concept)}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  strokeOpacity={0.75}
                  isAnimationActive={false}
                  connectNulls
                  dot={false}
                  label={(props: unknown) => {
                    const { key, x, y, index } = props as {
                      key?: React.Key;
                      x?: number;
                      y?: number;
                      index?: number;
                    };
                    if (index !== rows.length - 1 || x === undefined || y === undefined || !label) {
                      return <g key={key} />;
                    }
                    return (
                      <text
                        key={key}
                        x={x + 8}
                        y={y + 4 + label.dy}
                        fontSize={13}
                        fill={color}
                        className="font-sans"
                      >
                        {name.length > LABEL_MAX_CHARS ? `${name.slice(0, LABEL_MAX_CHARS - 1)}…` : name}
                      </text>
                    );
                  }}
                />,
              ];
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
