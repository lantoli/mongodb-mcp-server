/* eslint-disable @typescript-eslint/no-non-null-assertion -- expectedPeakConnections is type-narrowed by the typeof check */
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import type { AdvisoryEnvelope, Decision } from "./advisoryResult.js";
import { estimateClusterCost } from "./clusterCostModel.js";

export type WorkloadType = "development" | "production";
export type RegionFailureTolerance = 0 | 1 | 2;
export type DurabilityRequirement = "best-effort" | "audit-grade";
export type CloudProvider = "AWS" | "AZURE" | "GCP";

export interface WorkloadInput {
    name: string;
    type: WorkloadType;
    expectedPeakConnections?: number;
    regionFailureTolerance?: RegionFailureTolerance;
    durabilityRequirement?: DurabilityRequirement;
    primaryRegion?: string;
    cloudProvider?: CloudProvider;
    budgetMonthlyUSD?: number;
}

// Approximate connection ceilings per tier (MongoDB Atlas published guidance).
const TIER_CONNECTION_CEILING: Array<{ tier: string; max: number }> = [
    { tier: "M10", max: 350 },
    { tier: "M20", max: 700 },
    { tier: "M30", max: 2_000 },
    { tier: "M40", max: 4_000 },
    { tier: "M50", max: 8_000 },
    { tier: "M60", max: 16_000 },
    { tier: "M80", max: 32_000 },
    { tier: "M140", max: 96_000 },
    { tier: "M200", max: 128_000 },
    { tier: "M300", max: 128_000 },
];

const TIER_INDEX: Record<string, number> = {};
TIER_CONNECTION_CEILING.forEach((entry, idx) => {
    TIER_INDEX[entry.tier] = idx;
});

const NEXT_REGIONS_AWS: Record<string, string[]> = {
    US_EAST_1: ["US_WEST_2", "US_EAST_2", "EU_WEST_1", "AP_SOUTHEAST_1"],
    US_WEST_2: ["US_EAST_1", "US_EAST_2", "EU_WEST_1", "AP_SOUTHEAST_1"],
    EU_WEST_1: ["EU_CENTRAL_1", "EU_NORTH_1", "US_EAST_1", "AP_SOUTHEAST_1"],
    AP_SOUTHEAST_1: ["AP_NORTHEAST_1", "AP_SOUTH_1", "EU_WEST_1", "US_WEST_2"],
};
const FALLBACK_REGIONS_AWS = ["US_EAST_1", "US_WEST_2", "US_EAST_2", "EU_WEST_1", "AP_SOUTHEAST_1"];

const NEXT_REGIONS_AZURE: Record<string, string[]> = {
    US_EAST: ["US_WEST", "US_CENTRAL", "WEST_EUROPE", "SOUTHEAST_ASIA"],
};
const FALLBACK_REGIONS_AZURE = ["US_EAST", "US_WEST", "US_CENTRAL", "WEST_EUROPE", "SOUTHEAST_ASIA"];

const NEXT_REGIONS_GCP: Record<string, string[]> = {
    CENTRAL_US: ["EASTERN_US", "WESTERN_US", "WESTERN_EUROPE", "EASTERN_ASIA_PACIFIC"],
};
const FALLBACK_REGIONS_GCP = ["CENTRAL_US", "EASTERN_US", "WESTERN_US", "WESTERN_EUROPE", "EASTERN_ASIA_PACIFIC"];

function defaultPrimary(provider: CloudProvider): string {
    if (provider === "AZURE") return "US_EAST";
    if (provider === "GCP") return "CENTRAL_US";
    return "US_EAST_1";
}

function pickRegions(provider: CloudProvider, primary: string, count: number): string[] {
    const lookup = provider === "AZURE" ? NEXT_REGIONS_AZURE : provider === "GCP" ? NEXT_REGIONS_GCP : NEXT_REGIONS_AWS;
    const fallback =
        provider === "AZURE"
            ? FALLBACK_REGIONS_AZURE
            : provider === "GCP"
              ? FALLBACK_REGIONS_GCP
              : FALLBACK_REGIONS_AWS;
    const ordered = [primary, ...(lookup[primary] ?? fallback.filter((r) => r !== primary))];
    const uniq: string[] = [];
    for (const r of ordered) {
        if (!uniq.includes(r)) uniq.push(r);
        if (uniq.length === count) break;
    }
    while (uniq.length < count) {
        const candidate = fallback.find((r) => !uniq.includes(r));
        if (!candidate) break;
        uniq.push(candidate);
    }
    return uniq;
}

function pickElectableDistribution(regionCount: number): number[] {
    if (regionCount === 1) return [3];
    if (regionCount === 2) return [3, 2]; // 5 total, primary majority — uncommon but valid
    if (regionCount === 3) return [3, 2, 2];
    if (regionCount === 4) return [3, 2, 2, 2];
    return [3, 2, 2, 1, 1]; // 5+ regions: 9 total
}

function bumpTier(tier: string, by: number): string {
    const idx = TIER_INDEX[tier];
    if (idx === undefined) return tier;
    const target = Math.min(idx + by, TIER_CONNECTION_CEILING.length - 1);
    return TIER_CONNECTION_CEILING[target]?.tier ?? tier;
}

function pickInstanceTier(input: WorkloadInput): { tier: string; rationale: string } {
    if (input.type === "development") {
        return {
            tier: "M10",
            rationale: "development workload defaults to M10 (cheapest dedicated tier with autoscaling)",
        };
    }
    let chosen = "M30";
    let rationale = "production baseline is M30+";
    if (typeof input.expectedPeakConnections === "number") {
        const fit = TIER_CONNECTION_CEILING.find((entry) => entry.max >= input.expectedPeakConnections!);
        if (fit) {
            const idx = Math.max(TIER_INDEX[fit.tier] ?? 0, TIER_INDEX["M30"] ?? 0);
            chosen = TIER_CONNECTION_CEILING[idx]?.tier ?? fit.tier;
            rationale = `expectedPeakConnections=${input.expectedPeakConnections} fits within ${chosen}'s ~${TIER_CONNECTION_CEILING[idx]?.max ?? "?"} connection ceiling`;
        } else {
            chosen = "M300";
            rationale = `expectedPeakConnections=${input.expectedPeakConnections} exceeds published tier ceilings; sized at M300`;
        }
    }
    return { tier: chosen, rationale };
}

function regionCountFor(tolerance: RegionFailureTolerance | undefined): number {
    if (tolerance === 1) return 3;
    if (tolerance === 2) return 5;
    return 1;
}

export function recommendCluster(input: WorkloadInput): AdvisoryEnvelope<ClusterDescription20240805> {
    const decisions: Decision[] = [];
    const warnings: string[] = [];
    const provider: CloudProvider = input.cloudProvider ?? "AWS";
    const primaryRegion = input.primaryRegion ?? defaultPrimary(provider);
    const tolerance = input.regionFailureTolerance ?? 0;

    const tierInfo = pickInstanceTier(input);
    decisions.push({ field: "instanceSize", chose: tierInfo.tier, because: tierInfo.rationale });

    const regionCount = regionCountFor(tolerance);
    decisions.push({
        field: "regionCount",
        chose: regionCount,
        because:
            tolerance === 0
                ? "regionFailureTolerance=0 ⇒ single region (no cross-region quorum needed)"
                : tolerance === 1
                  ? "regionFailureTolerance=1 ⇒ 3 regions to retain quorum after one regional outage"
                  : "regionFailureTolerance=2 ⇒ 5 regions to retain quorum after two regional outages",
    });

    const regions = pickRegions(provider, primaryRegion, regionCount);
    decisions.push({
        field: "regions",
        chose: regions,
        because: `primary=${primaryRegion} on ${provider}; secondary regions chosen for geographic separation`,
    });

    const electable = pickElectableDistribution(regionCount);
    decisions.push({
        field: "electableNodes",
        chose: electable,
        because: `total ${electable.reduce((a, b) => a + b, 0)} electable nodes (odd ⇒ quorum-safe; primary holds majority)`,
    });

    const minTier = tierInfo.tier;
    const maxTier = bumpTier(tierInfo.tier, 2);
    decisions.push({
        field: "autoScaling",
        chose: {
            compute: { enabled: true, minInstanceSize: minTier, maxInstanceSize: maxTier },
            diskGB: { enabled: true },
        },
        because:
            "compute + disk autoscaling enabled; max two tiers above baseline absorbs flash-traffic without manual scaling",
    });

    const backupEnabled = input.type === "production" || input.durabilityRequirement === "audit-grade";
    if (backupEnabled) {
        decisions.push({
            field: "backupEnabled",
            chose: true,
            because:
                input.durabilityRequirement === "audit-grade"
                    ? "audit-grade durability ⇒ daily snapshots required"
                    : "production workloads default to backup for disaster recovery",
        });
    }

    const pitEnabled = input.durabilityRequirement === "audit-grade";
    if (pitEnabled) {
        decisions.push({
            field: "pitEnabled",
            chose: true,
            because: "audit-grade durability ⇒ continuous (point-in-time) backups",
        });
    }

    const replicationSpecs = [
        {
            zoneName: "Zone 1",
            regionConfigs: regions.map((regionName, idx) => ({
                providerName: provider,
                regionName,
                priority: 7 - idx,
                electableSpecs: { instanceSize: tierInfo.tier, nodeCount: electable[idx] ?? 0 },
                autoScaling: {
                    compute: {
                        enabled: true,
                        scaleDownEnabled: true,
                        minInstanceSize: minTier,
                        maxInstanceSize: maxTier,
                    },
                    diskGB: { enabled: true },
                },
            })),
        },
    ];

    const body = {
        name: input.name,
        clusterType: "REPLICASET" as const,
        replicationSpecs,
        backupEnabled,
        ...(pitEnabled ? { pitEnabled: true } : {}),
        terminationProtectionEnabled: false,
    } as unknown as ClusterDescription20240805;

    const cost = estimateClusterCost(body);

    if (input.budgetMonthlyUSD && cost.total > input.budgetMonthlyUSD) {
        warnings.push(
            `Recommended config (~$${cost.total}/mo) exceeds budget cap ($${input.budgetMonthlyUSD}). ` +
                `Consider lowering regionFailureTolerance, expectedPeakConnections, or workload type.`
        );
    }

    return { body, decisions, warnings, estimatedMonthlyCost: cost };
}
