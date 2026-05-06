import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";

export class CreateClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-cluster";
    public description =
        "Create a MongoDB Atlas cluster. The body mirrors the Atlas API ClusterDescription schema. " +
        "For dedicated tiers (M10+) provide replicationSpecs[].regionConfigs[] with priority: 7 on the " +
        "primary region and electableSpecs.nodeCount (typically 3). For SHARDED clusters, supply one " +
        "replicationSpecs[] entry per shard (Independent Shard Scaling format, no numShards).";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID to create the cluster in"),
        ...ClusterBodyShape,
    };

    protected async execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const { projectId, ...body } = args;
        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        const cluster = await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body: body as unknown as ClusterDescription20240805,
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${body.name ?? cluster.name ?? ""}" creation requested in project ${projectId}.`,
                },
                { type: "text", text: JSON.stringify(cluster, null, 2) },
            ],
        };
    }
}
