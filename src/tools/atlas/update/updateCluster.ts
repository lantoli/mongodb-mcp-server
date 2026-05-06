import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";
import { ApiClientError } from "../../../common/atlas/apiClientError.js";

export class UpdateClusterTool extends AtlasToolBase {
    static toolName = "atlas-update-cluster";
    public description =
        "Update a MongoDB Atlas cluster. Pass any subset of fields to change. " +
        "Pause: { paused: true }. Resume: { paused: false }. Scale tier or change autoscaling: " +
        "modified replicationSpecs. Atlas rejects updates unless the cluster is IDLE, so call " +
        "atlas-get-cluster first and only call this tool once stateName == 'IDLE'.";
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

    protected handleError(
        error: unknown,
        args: ToolArgs<typeof this.argsShape>
    ): Promise<CallToolResult> | CallToolResult {
        if (
            error instanceof ApiClientError &&
            args.paused !== undefined &&
            /CANNOT_UPDATE_PAUSED_CLUSTER|cluster.*not.*idle|currently.*(creating|updating|deleting)|in this state/i.test(
                error.message
            )
        ) {
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Atlas rejected the pause/resume because cluster "${args.clusterName}" is not IDLE: ${error.message}. ` +
                            `Call atlas-get-cluster and wait until stateName === "IDLE" (cluster build/transition typically takes a few minutes), then retry this update.`,
                    },
                ],
                isError: true,
            };
        }
        return super.handleError(error, args);
    }
}
