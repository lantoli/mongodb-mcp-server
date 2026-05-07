import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { validateClusterBody } from "../shared/clusterValidator.js";

export class ValidateClusterBodyTool extends AtlasToolBase {
    static toolName = "atlas-validate-cluster-body";
    public description =
        "Validate a candidate ClusterDescription body against Atlas rules: priority distinctness " +
        "(7 on primary only), electable quorum (odd, >=3), electable per region, production-tier " +
        "backup, M0/TENANT no-backup, sharded shape, autoscaling completeness. Returns issues[] + " +
        "an auto-fixed body suggestion. No Atlas API call.";
    static operationType: OperationType = "metadata";

    public argsShape = {
        body: z.record(z.string(), z.unknown()).describe("Candidate ClusterDescription body to lint"),
    };

    protected execute({ body }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const result = validateClusterBody(body as unknown as ClusterDescription20240805);
        return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    }
}
