/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- recommender returns openapi-typed bodies whose nested fields the linter can't resolve through; tests assert known structure */
import { describe, it, expect } from "vitest";
import { recommendCluster } from "../../../../src/tools/atlas/shared/clusterRecommender.js";

describe("clusterRecommender", () => {
    it("ex1/ex2 dev: M10 single-region AWS US_EAST_1 with autoscaling, no backup", () => {
        const r = recommendCluster({
            name: "dev1",
            type: "development",
            expectedPeakConnections: 50,
        });
        const body = r.body!;
        expect(body.clusterType).toBe("REPLICASET");
        expect(body.replicationSpecs).toHaveLength(1);
        const rcs = body.replicationSpecs![0]!.regionConfigs!;
        expect(rcs).toHaveLength(1);
        expect(rcs[0]!.providerName).toBe("AWS");
        expect(rcs[0]!.regionName).toBe("US_EAST_1");
        expect(rcs[0]!.priority).toBe(7);
        expect(rcs[0]!.electableSpecs!.instanceSize).toBe("M10");
        expect(rcs[0]!.electableSpecs!.nodeCount).toBe(3);
        expect(rcs[0]!.autoScaling!.compute!.enabled).toBe(true);
        expect(rcs[0]!.autoScaling!.diskGB!.enabled).toBe(true);
        expect(body.backupEnabled).toBe(false);
        expect((body as { pitEnabled?: boolean }).pitEnabled).toBeUndefined();
        expect(r.decisions.length).toBeGreaterThan(0);
        expect(r.estimatedMonthlyCost!.total).toBeGreaterThan(0);
    });

    it("ex3 budget prod: M30+, single region US_EAST_1, autoscaling, backup, no analytics/readonly", () => {
        const r = recommendCluster({
            name: "prod3",
            type: "production",
            expectedPeakConnections: 500,
            durabilityRequirement: "audit-grade",
            regionFailureTolerance: 0,
        });
        const body = r.body!;
        expect(body.clusterType).toBe("REPLICASET");
        expect(body.replicationSpecs).toHaveLength(1);
        const rcs = body.replicationSpecs![0]!.regionConfigs!;
        expect(rcs).toHaveLength(1);
        expect(rcs[0]!.regionName).toBe("US_EAST_1");
        expect(rcs[0]!.providerName).toBe("AWS");
        const tier = rcs[0]!.electableSpecs!.instanceSize!;
        expect(["M30", "M40", "M50", "M60"]).toContain(tier);
        expect(rcs[0]!.autoScaling!.compute!.enabled).toBe(true);
        expect(rcs[0]!.autoScaling!.diskGB!.enabled).toBe(true);
        expect(body.backupEnabled).toBe(true);
        expect((body as { pitEnabled?: boolean }).pitEnabled).toBe(true);
        // No analytics / readonly nodes
        for (const rc of rcs) {
            expect((rc as { analyticsSpecs?: unknown }).analyticsSpecs).toBeUndefined();
            expect((rc as { readOnlySpecs?: unknown }).readOnlySpecs).toBeUndefined();
        }
    });

    it("ex4 HA prod: M30+, 3 regions, electable in each, >=5 total electable, backup", () => {
        const r = recommendCluster({
            name: "ha4",
            type: "production",
            expectedPeakConnections: 8000,
            durabilityRequirement: "audit-grade",
            regionFailureTolerance: 1,
        });
        const body = r.body!;
        expect(body.clusterType).toBe("REPLICASET");
        const rcs = body.replicationSpecs![0]!.regionConfigs!;
        expect(rcs.length).toBeGreaterThanOrEqual(3);

        const totalElectable = rcs.reduce((sum, rc) => sum + (rc.electableSpecs?.nodeCount ?? 0), 0);
        expect(totalElectable).toBeGreaterThanOrEqual(5);
        // Each region has electable nodes
        for (const rc of rcs) {
            expect(rc.electableSpecs!.nodeCount).toBeGreaterThan(0);
        }
        // Priorities distinct, primary is 7
        const priorities = rcs.map((rc) => rc.priority);
        expect(priorities[0]).toBe(7);
        expect(new Set(priorities).size).toBe(priorities.length);

        // All AWS, primary US_EAST_1
        expect(rcs[0]!.providerName).toBe("AWS");
        expect(rcs[0]!.regionName).toBe("US_EAST_1");
        expect(body.backupEnabled).toBe(true);
        // M30+ tier
        const tier = rcs[0]!.electableSpecs!.instanceSize!;
        expect(parseInt(tier.slice(1), 10)).toBeGreaterThanOrEqual(30);
    });

    it("warns when budget cap is exceeded", () => {
        const r = recommendCluster({
            name: "expensive",
            type: "production",
            expectedPeakConnections: 8000,
            regionFailureTolerance: 1,
            budgetMonthlyUSD: 100,
        });
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toMatch(/budget/i);
    });
});
