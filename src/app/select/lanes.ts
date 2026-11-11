import { gapsWithin, type Interval } from '../ingest/coverage';

export function coverageGaps(coverage: Interval[], window: Interval): Interval[] {
  return gapsWithin(coverage, window.from, window.to);
}
