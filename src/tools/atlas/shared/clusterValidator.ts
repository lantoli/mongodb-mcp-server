import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import type { AdvisoryEnvelope, ValidationIssue } from "./advisoryResult.js";
import { estimateClusterCost } from "./clusterCostModel.js";

const TIER_RANK: Record<string, number> = {
    M0: 0,
    M2: 2,
    M5: 5,
    M10: 10,
    M20: 20,
    M30: 30,
    M40: 40,
    M50: 50,
    M60: 60,
    M80: 80,
    M100: 100,
    M140: 140,
    M200: 200,
    M300: 300,
    M400: 400,
    M700: 700,
};

function tierRank(size: string | undefined): number {
    return size ? (TIER_RANK[size] ?? 0) : 0;
}

function bumpTierBy(size: string, by: number): string {
    const rank = tierRank(size);
    const ordered = Object.entries(TIER_RANK).sort(([, a], [, b]) => a - b);
    const idx = ordered.findIndex(([, r]) => r === rank);
    if (idx < 0) return size;
    const target = Math.min(idx + by, ordered.length - 1);
    return ordered[target]?.[0] ?? size;
}

interface RegionConfigLike {
    providerName?: string;
    regionName?: string;
    priority?: number;
    electableSpecs?: { instanceSize?: string; nodeCount?: number };
    readOnlySpecs?: { instanceSize?: string; nodeCount?: number };
    analyticsSpecs?: { instanceSize?: string; nodeCount?: number };
    autoScaling?: {
        compute?: { enabled?: boolean; minInstanceSize?: string; maxInstanceSize?: string; scaleDownEnabled?: boolean };
        diskGB?: { enabled?: boolean };
    };
}

interface ReplicationSpecLike {
    zoneName?: string;
    regionConfigs?: RegionConfigLike[];
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export interface ValidationResult extends AdvisoryEnvelope<ClusterDescription20240805> {
    issues: ValidationIssue[];
    autoFixedBody: ClusterDescription20240805;
}

export function validateClusterBody(input: ClusterDescription20240805): ValidationResult {
    const issues: ValidationIssue[] = [];
    const fixed = clone(input);
    const specs = (fixed.replicationSpecs ?? []) as ReplicationSpecLike[];

    // Rule: priority-7-collision per replicationSpec
    specs.forEach((spec, sIdx) => {
        const regionConfigs = spec.regionConfigs ?? [];
        const sevens = regionConfigs.filter((rc) => rc.priority === 7);
        if (sevens.length > 1) {
            // Sort by electable nodeCount desc; the first keeps 7, others get descending priorities.
            const ordered = [...regionConfigs].sort(
                (a, b) => (b.electableSpecs?.nodeCount ?? 0) - (a.electableSpecs?.nodeCount ?? 0)
            );
            ordered.forEach((rc, idx) => {
                rc.priority = 7 - idx;
            });
            issues.push({
                level: "error",
                field: `replicationSpecs[${sIdx}].regionConfigs[].priority`,
                current: sevens.length,
                suggested: "7 on primary region only; others 6, 5, 4, ...",
                because: "Atlas rejects bodies with priority=7 on more than one region (HTTP 400).",
            });
        }
    });

    // Rule: electable-quorum (total odd, ≥3, ≥5 if multi-region)
    const totalElectable = specs.reduce(
        (sum, spec) => sum + (spec.regionConfigs ?? []).reduce((s, rc) => s + (rc.electableSpecs?.nodeCount ?? 0), 0),
        0
    );
    const regionCount = specs.reduce((sum, spec) => sum + (spec.regionConfigs?.length ?? 0), 0);
    const isMultiRegion = regionCount > 1;
    const quorumMin = isMultiRegion ? 5 : 3;
    if (totalElectable < quorumMin || totalElectable % 2 === 0) {
        const suggested = isMultiRegion ? (regionCount >= 3 ? [3, 2, 2] : [3, 2]) : [3];
        issues.push({
            level: "error",
            field: "replicationSpecs[].regionConfigs[].electableSpecs.nodeCount",
            current: totalElectable,
            suggested: `total ${suggested.reduce((a, b) => a + b, 0)} (odd, primary-majority)`,
            because: `replica-set quorum requires odd total electable nodes ≥ ${quorumMin}.`,
        });
    }

    // Rule: electable-per-region (every region with priority>0 should have electable nodes)
    specs.forEach((spec, sIdx) => {
        (spec.regionConfigs ?? []).forEach((rc, rIdx) => {
            if ((rc.priority ?? 0) > 0 && !rc.electableSpecs?.nodeCount) {
                issues.push({
                    level: "warning",
                    field: `replicationSpecs[${sIdx}].regionConfigs[${rIdx}].electableSpecs.nodeCount`,
                    current: rc.electableSpecs?.nodeCount ?? 0,
                    suggested: rIdx === 0 ? 3 : 2,
                    because: "every region with priority > 0 should have electable nodes for quorum participation.",
                });
                if (!rc.electableSpecs) rc.electableSpecs = {};
                rc.electableSpecs.nodeCount = rIdx === 0 ? 3 : 2;
                if (!rc.electableSpecs.instanceSize) {
                    // Borrow the first known tier in the spec.
                    const known = (spec.regionConfigs ?? [])
                        .map((other) => other.electableSpecs?.instanceSize)
                        .find((s) => !!s);
                    if (known) rc.electableSpecs.instanceSize = known;
                }
            }
        });
    });

    // Rule: production-tier-no-backup
    const maxTier = specs.reduce((maxRank, spec) => {
        const specMax = (spec.regionConfigs ?? []).reduce((m, rc) => {
            const r = Math.max(
                tierRank(rc.electableSpecs?.instanceSize),
                tierRank(rc.readOnlySpecs?.instanceSize),
                tierRank(rc.analyticsSpecs?.instanceSize)
            );
            return Math.max(m, r);
        }, 0);
        return Math.max(maxRank, specMax);
    }, 0);
    if (maxTier >= 30 && fixed.backupEnabled !== true) {
        issues.push({
            level: "warning",
            field: "backupEnabled",
            current: fixed.backupEnabled ?? false,
            suggested: true,
            because: "production tiers (M30+) should enable backups for disaster recovery / audit requirements.",
        });
        fixed.backupEnabled = true;
    }

    // Rule: M0/TENANT + backup
    const hasTenant = specs.some((spec) =>
        (spec.regionConfigs ?? []).some(
            (rc) => rc.providerName === "TENANT" || rc.electableSpecs?.instanceSize === "M0"
        )
    );
    if (hasTenant && fixed.backupEnabled === true) {
        issues.push({
            level: "error",
            field: "backupEnabled",
            current: true,
            suggested: false,
            because: "TENANT (M0/M2/M5) clusters do not support Atlas backups.",
        });
        fixed.backupEnabled = false;
    }

    // Rule: sharded-single-spec
    if (input.clusterType === "SHARDED" && specs.length === 1) {
        issues.push({
            level: "warning",
            field: "replicationSpecs.length",
            current: 1,
            suggested: 2,
            because: "SHARDED clusters typically need ≥2 shards (Independent Shard Scaling format).",
        });
    }

    // Rule: autoscaling-incomplete
    specs.forEach((spec, sIdx) => {
        (spec.regionConfigs ?? []).forEach((rc, rIdx) => {
            const compute = rc.autoScaling?.compute;
            if (compute?.enabled && !compute.maxInstanceSize) {
                const baseline = rc.electableSpecs?.instanceSize ?? "M10";
                const max = bumpTierBy(baseline, 2);
                issues.push({
                    level: "error",
                    field: `replicationSpecs[${sIdx}].regionConfigs[${rIdx}].autoScaling.compute.maxInstanceSize`,
                    current: undefined,
                    suggested: max,
                    because: "compute autoscaling requires maxInstanceSize when enabled.",
                });
                compute.maxInstanceSize = max;
            }
            if (compute?.enabled && compute.scaleDownEnabled && !compute.minInstanceSize) {
                const min = rc.electableSpecs?.instanceSize ?? "M10";
                issues.push({
                    level: "error",
                    field: `replicationSpecs[${sIdx}].regionConfigs[${rIdx}].autoScaling.compute.minInstanceSize`,
                    current: undefined,
                    suggested: min,
                    because: "compute scale-down autoscaling requires minInstanceSize.",
                });
                compute.minInstanceSize = min;
            }
        });
    });

    return {
        issues,
        autoFixedBody: fixed,
        body: fixed,
        decisions: [],
        warnings: issues.filter((i) => i.level === "warning").map((i) => `${i.field}: ${i.because}`),
        estimatedMonthlyCost: estimateClusterCost(fixed),
    };
}
