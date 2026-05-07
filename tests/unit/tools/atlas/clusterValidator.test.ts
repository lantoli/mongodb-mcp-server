/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- validator works on openapi-typed bodies whose nested fields the linter can't resolve through */
import { describe, it, expect } from "vitest";
import type { ClusterDescription20240805 } from "../../../../src/common/atlas/openapi.js";
import { validateClusterBody } from "../../../../src/tools/atlas/shared/clusterValidator.js";

function makeBody(overrides: Partial<ClusterDescription20240805>): ClusterDescription20240805 {
    return {
        clusterType: "REPLICASET",
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
        ...overrides,
    } as unknown as ClusterDescription20240805;
}

describe("clusterValidator", () => {
    it("flags multiple priority=7 and auto-fixes", () => {
        const body = makeBody({
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
                            priority: 7,
                            electableSpecs: { instanceSize: "M30", nodeCount: 2 },
                        },
                    ],
                },
            ],
        });
        const r = validateClusterBody(body);
        expect(r.issues.some((i) => i.field.includes("priority"))).toBe(true);
        const rcs = r.autoFixedBody.replicationSpecs![0]!.regionConfigs!;
        const priorities = rcs.map((rc) => rc.priority);
        expect(new Set(priorities).size).toBe(priorities.length);
        expect(priorities).toContain(7);
    });

    it("flags even or <3 total electable", () => {
        const body = makeBody({
            replicationSpecs: [
                {
                    regionConfigs: [
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_1",
                            priority: 7,
                            electableSpecs: { instanceSize: "M10", nodeCount: 2 },
                        },
                    ],
                },
            ],
        });
        const r = validateClusterBody(body);
        expect(r.issues.some((i) => i.because.toLowerCase().includes("quorum"))).toBe(true);
    });

    it("warns when M30+ has backupEnabled false and auto-fixes to true", () => {
        const body = makeBody({
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
            backupEnabled: false,
        });
        const r = validateClusterBody(body);
        expect(r.issues.some((i) => i.field === "backupEnabled" && i.suggested === true)).toBe(true);
        expect(r.autoFixedBody.backupEnabled).toBe(true);
    });

    it("rejects backupEnabled=true on TENANT (M0) clusters", () => {
        const body = makeBody({
            replicationSpecs: [
                {
                    regionConfigs: [
                        {
                            providerName: "TENANT",
                            backingProviderName: "AWS",
                            regionName: "US_EAST_1",
                            electableSpecs: { instanceSize: "M0" },
                        },
                    ],
                },
            ],
            backupEnabled: true,
        });
        const r = validateClusterBody(body);
        expect(r.issues.some((i) => i.field === "backupEnabled" && i.level === "error")).toBe(true);
        expect(r.autoFixedBody.backupEnabled).toBe(false);
    });

    it("warns when SHARDED has only one replicationSpec", () => {
        const body = makeBody({
            clusterType: "SHARDED",
        });
        const r = validateClusterBody(body);
        expect(r.issues.some((i) => i.field === "replicationSpecs.length")).toBe(true);
    });

    it("auto-fills missing autoScaling.maxInstanceSize when compute.enabled=true", () => {
        const body = makeBody({
            replicationSpecs: [
                {
                    regionConfigs: [
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_1",
                            priority: 7,
                            electableSpecs: { instanceSize: "M10", nodeCount: 3 },
                            autoScaling: { compute: { enabled: true } },
                        },
                    ],
                },
            ],
        });
        const r = validateClusterBody(body);
        const fixedRc = r.autoFixedBody.replicationSpecs![0]!.regionConfigs![0]!;
        expect(fixedRc.autoScaling!.compute!.maxInstanceSize).toBeDefined();
    });

    it("returns no errors for a clean ex2-style body", () => {
        const body = makeBody({}); // M10, single-region, 3 nodes, no backup
        const r = validateClusterBody(body);
        const errors = r.issues.filter((i) => i.level === "error");
        expect(errors).toHaveLength(0);
    });
});
