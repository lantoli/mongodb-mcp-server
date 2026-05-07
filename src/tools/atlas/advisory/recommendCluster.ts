import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import { recommendCluster } from "../shared/clusterRecommender.js";

export class RecommendClusterTool extends AtlasToolBase {
    static toolName = "atlas-recommend-cluster";
    public description =
        "Recommend a complete Atlas cluster body from workload constraints. Returns the body + " +
        "decisions[] (which fields were chosen and why) + estimatedMonthlyCost. Does NOT call the " +
        "Atlas API. Use this to plan a cluster before atlas-create-cluster, especially when the " +
        "agent is unsure about tier sizing, multi-region layout, electable node distribution, or " +
        "backup defaults. The returned body can be passed verbatim to atlas-create-cluster.";
    static operationType: OperationType = "metadata";

    public argsShape = {
        name: AtlasArgs.clusterName().describe("Cluster name"),
        workloadType: z.enum(["development", "production"]).describe("Drives tier and backup defaults"),
        expectedPeakConnections: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Expected peak concurrent connections; drives instance tier"),
        regionFailureTolerance: z
            .union([z.literal(0), z.literal(1), z.literal(2)])
            .optional()
            .describe("0=single region, 1=3-region HA (survives 1 region failure), 2=5-region (survives 2)"),
        durabilityRequirement: z
            .enum(["best-effort", "audit-grade"])
            .optional()
            .describe("audit-grade implies daily backups + point-in-time recovery"),
        primaryRegion: z.string().optional().describe("Primary region (default US_EAST_1 for AWS)"),
        cloudProvider: z.enum(["AWS", "AZURE", "GCP"]).optional().describe("Cloud provider (default AWS)"),
        budgetMonthlyUSD: z
            .number()
            .positive()
            .optional()
            .describe("Soft cap; produces a warning if recommended config exceeds it"),
    };

    protected execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const result = recommendCluster({
            name: args.name,
            type: args.workloadType,
            expectedPeakConnections: args.expectedPeakConnections,
            regionFailureTolerance: args.regionFailureTolerance,
            durabilityRequirement: args.durabilityRequirement,
            primaryRegion: args.primaryRegion,
            cloudProvider: args.cloudProvider,
            budgetMonthlyUSD: args.budgetMonthlyUSD,
        });
        return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    }
}
