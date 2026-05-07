import { describe, it, expect } from "vitest";
import type { ClusterDescription20240805 } from "../../../../src/common/atlas/openapi.js";
import { estimateClusterCost, tierHourlyRate } from "../../../../src/tools/atlas/shared/clusterCostModel.js";

describe("clusterCostModel", () => {
    it("returns 0 for unknown tier", () => {
        expect(tierHourlyRate(undefined)).toBe(0);
        expect(tierHourlyRate("X999")).toBe(0);
    });

    it("rates M10 at ~$0.08/node-hour", () => {
        expect(tierHourlyRate("M10")).toBeCloseTo(0.08, 2);
    });

    it("estimates a single-region M10 3-node replica set without backup", () => {
        const body = {
            replicationSpecs: [
                {
                    regionConfigs: [
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_1",
                            priority: 7,
                            electableSpecs: { instanceSize: "M10", nodeCount: 3 },
                        },
                    ],
                },
            ],
            backupEnabled: false,
        } as unknown as ClusterDescription20240805;

        const cost = estimateClusterCost(body);
        // 3 nodes × $0.08 × 730 hrs = $175.20
        expect(cost.compute).toBeCloseTo(175.2, 1);
        expect(cost.backup).toBe(0);
        expect(cost.total).toBeCloseTo(175.2, 1);
    });

    it("adds ~10% for backup-enabled clusters", () => {
        const body = {
            replicationSpecs: [
                {
                    regionConfigs: [
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_1",
                            priority: 7,
                            electableSpecs: { instanceSize: "M30", nodeCount: 3 },
                        },
                    ],
                },
            ],
            backupEnabled: true,
        } as unknown as ClusterDescription20240805;

        const cost = estimateClusterCost(body);
        expect(cost.compute).toBeCloseTo(0.54 * 3 * 730, 0);
        expect(cost.backup).toBeCloseTo(cost.compute * 0.1, 0);
        expect(cost.total).toBeCloseTo(cost.compute + cost.backup, 0);
    });

    it("sums across multi-region replicaSpec", () => {
        const body = {
            replicationSpecs: [
                {
                    regionConfigs: [
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_1",
                            priority: 7,
                            electableSpecs: { instanceSize: "M30", nodeCount: 3 },
                        },
                        {
                            providerName: "AWS",
                            regionName: "US_WEST_2",
                            priority: 6,
                            electableSpecs: { instanceSize: "M30", nodeCount: 2 },
                        },
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_2",
                            priority: 5,
                            electableSpecs: { instanceSize: "M30", nodeCount: 2 },
                        },
                    ],
                },
            ],
            backupEnabled: true,
        } as unknown as ClusterDescription20240805;
        const cost = estimateClusterCost(body);
        // 7 nodes × $0.54 × 730 = $2759.4 compute + 10% backup
        expect(cost.compute).toBeCloseTo(0.54 * 7 * 730, 0);
        expect(cost.total).toBeGreaterThan(cost.compute);
    });

    it("returns the disclaimer note", () => {
        const body = { replicationSpecs: [] } as unknown as ClusterDescription20240805;
        const cost = estimateClusterCost(body);
        expect(cost.note).toMatch(/Approximate/);
        expect(cost.currency).toBe("USD");
    });
});
