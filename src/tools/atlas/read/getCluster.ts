import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";

export class GetClusterTool extends AtlasToolBase {
    static toolName = "atlas-get-cluster";
    public description =
        "Get the full Atlas cluster description as JSON, including stateName, replicationSpecs, " +
        'autoScaling, paused, and connectionStrings. Call this before atlas-update-cluster to verify the cluster is "IDLE".';
    static operationType: OperationType = "read";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster"),
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const cluster = await this.apiClient.getCluster({
            params: { path: { groupId: projectId, clusterName } },
        });
        return { content: [{ type: "text", text: JSON.stringify(cluster, null, 2) }] };
    }
}
