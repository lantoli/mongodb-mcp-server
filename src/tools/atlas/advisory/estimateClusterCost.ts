import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { estimateClusterCost } from "../shared/clusterCostModel.js";

export class EstimateClusterCostTool extends AtlasToolBase {
    static toolName = "atlas-estimate-cluster-cost";
    public description =
        "Estimate the monthly USD cost of a ClusterDescription body. Returns total + breakdown " +
        "(compute, backup) using AWS list prices. No Atlas API call. Use to compare configs " +
        "before atlas-create-cluster.";
    static operationType: OperationType = "metadata";

    public argsShape = {
        body: z.record(z.string(), z.unknown()).describe("ClusterDescription body to price"),
    };

    protected execute({ body }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const cost = estimateClusterCost(body as unknown as ClusterDescription20240805);
        return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(cost, null, 2) }] });
    }
}
