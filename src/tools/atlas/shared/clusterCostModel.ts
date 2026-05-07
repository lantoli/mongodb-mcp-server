/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- openapi types use intersections that the linter can't resolve through */
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import type { CostBreakdown } from "./advisoryResult.js";

// Approximate AWS list prices per Atlas tier, USD per node-hour.
// Sources: Atlas pricing pages as of 2026-05; figures are directional, not authoritative.
const AWS_HOURLY_USD: Record<string, number> = {
    M0: 0,
    M2: 0.011,
    M5: 0.027,
    M10: 0.08,
    M20: 0.2,
    M30: 0.54,
    M40: 1.04,
    M50: 2.05,
    M60: 1.86,
    M80: 3.97,
    M100: 7.94,
    M140: 11.46,
    M200: 15.88,
    M300: 31.76,
    M400: 41.21,
    M700: 75.0,
};

const HOURS_PER_MONTH = 730;
const BACKUP_COST_FRACTION = 0.1;

function round(n: number): number {
    return Math.round(n * 100) / 100;
}

export function tierHourlyRate(instanceSize: string | undefined): number {
    if (!instanceSize) return 0;
    return AWS_HOURLY_USD[instanceSize] ?? 0;
}

export function estimateClusterCost(body: ClusterDescription20240805): CostBreakdown {
    let compute = 0;
    for (const spec of body.replicationSpecs ?? []) {
        for (const rc of spec.regionConfigs ?? []) {
            for (const sub of [rc.electableSpecs, rc.readOnlySpecs, rc.analyticsSpecs]) {
                if (!sub?.instanceSize || !sub.nodeCount) continue;
                compute += tierHourlyRate(sub.instanceSize) * sub.nodeCount * HOURS_PER_MONTH;
            }
        }
    }
    const backup = body.backupEnabled ? compute * BACKUP_COST_FRACTION : 0;
    return {
        total: round(compute + backup),
        compute: round(compute),
        backup: round(backup),
        currency: "USD",
        note: "Approximate AWS list price; Atlas reserved-instance pricing and disk/backup actuals may vary.",
    };
}
