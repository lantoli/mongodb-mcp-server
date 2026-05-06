import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";

// Sensible default for a single-region dev replica set (matches hackathon-examples/replica-set-request.json):
// AWS US_EAST_1, M10, 3 electable nodes, compute + disk autoscaling up to M40.
// Applied only when the caller omits replicationSpecs entirely; any explicit value passes through unchanged.
const DEFAULT_REPLICATION_SPECS = [
    {
        zoneName: "Zone 1",
        regionConfigs: [
            {
                providerName: "AWS",
                regionName: "US_EAST_1",
                priority: 7,
                electableSpecs: { instanceSize: "M10", nodeCount: 3 },
                autoScaling: {
                    compute: {
                        enabled: true,
                        scaleDownEnabled: true,
                        minInstanceSize: "M10",
                        maxInstanceSize: "M40",
                    },
                    diskGB: { enabled: true },
                },
            },
        ],
    },
];

export class CreateClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-cluster";
    public description =
        "Create a MongoDB Atlas cluster. The body mirrors the Atlas API ClusterDescription schema. " +
        "For dedicated tiers (M10+) provide replicationSpecs[].regionConfigs[] with priority: 7 on the " +
        "primary region and electableSpecs.nodeCount (typically 3). For SHARDED clusters, supply one " +
        "replicationSpecs[] entry per shard (Independent Shard Scaling format, no numShards). " +
        "If replicationSpecs is omitted, a single-region AWS US_EAST_1 M10 replica set with compute + " +
        "disk autoscaling (M10–M40) is used.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID to create the cluster in"),
        ...ClusterBodyShape,
    };

    protected async execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const { projectId, ...body } = args;
        if (!body.replicationSpecs || body.replicationSpecs.length === 0) {
            body.replicationSpecs = DEFAULT_REPLICATION_SPECS as unknown as typeof body.replicationSpecs;
        }
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
