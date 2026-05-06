import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";

export class DeleteClusterTool extends AtlasToolBase {
    static toolName = "atlas-delete-cluster";
    public description =
        "Delete an Atlas cluster. The cluster must have terminationProtectionEnabled=false " +
        "(disable it first via atlas-update-cluster if needed).";
    static operationType: OperationType = "delete";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to delete"),
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        await this.apiClient.deleteCluster({
            params: { path: { groupId: projectId, clusterName } },
        });
        return {
            content: [{ type: "text", text: `Cluster "${clusterName}" deletion requested.` }],
        };
    }
}
