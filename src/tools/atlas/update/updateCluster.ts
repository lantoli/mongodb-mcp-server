import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";

export class UpdateClusterTool extends AtlasToolBase {
    static toolName = "atlas-update-cluster";
    public description =
        "Update a MongoDB Atlas cluster. Pass any subset of fields to change " +
        "(e.g. { paused: true } to pause, modified replicationSpecs to scale tier or change autoscaling). " +
        "The cluster must be in IDLE state, call atlas-get-cluster first to verify.";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to update"),
        ...ClusterBodyShape,
    };

    protected async execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const { projectId, clusterName, ...rest } = args;
        // `name` is path-bound (clusterName); the API rejects rename attempts.
        delete (rest as { name?: string }).name;
        const updated = await this.apiClient.updateCluster({
            params: { path: { groupId: projectId, clusterName } },
            body: rest,
        });
        return {
            content: [
                { type: "text", text: `Cluster "${clusterName}" update requested.` },
                { type: "text", text: JSON.stringify(updated, null, 2) },
            ],
        };
    }
}
