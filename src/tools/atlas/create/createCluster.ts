import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";

// Defaults applied only when the caller omits replicationSpecs entirely.
// Any explicit replicationSpecs passes through unchanged.
//   REPLICASET (or unspecified) -> single AWS US_EAST_1 M10, autoscaling M10-M40 (matches hackathon-examples/replica-set-request.json).
//   SHARDED -> two identical AWS US_EAST_1 M30 shards, autoscaling M30-M60 (matches hackathon-examples/sharded-request.json).
function buildShard(instanceSize: string, minInstanceSize: string, maxInstanceSize: string): unknown {
    return {
        zoneName: "Zone 1",
        regionConfigs: [
            {
                providerName: "AWS",
                regionName: "US_EAST_1",
                priority: 7,
                electableSpecs: { instanceSize, nodeCount: 3 },
                autoScaling: {
                    compute: {
                        enabled: true,
                        scaleDownEnabled: true,
                        minInstanceSize,
                        maxInstanceSize,
                    },
                    diskGB: { enabled: true },
                },
            },
        ],
    };
}

const DEFAULT_REPLICA_SET_SPECS = [buildShard("M10", "M10", "M40")];
const DEFAULT_SHARDED_SPECS = [buildShard("M30", "M30", "M60"), buildShard("M30", "M30", "M60")];

export class CreateClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-cluster";
    public description =
        "Create a MongoDB Atlas cluster. The body mirrors the Atlas API ClusterDescription schema. " +
        "Pass replicationSpecs[] explicitly for any non-trivial sizing; the defaults below are dev-only. " +
        "Sizing rules: dev = M10/M20 (cheapest with autoscaling). Production = M30+. Always set " +
        "priority: 7 on the primary region and electableSpecs.nodeCount: 3. " +
        "Single-region: 1 replicationSpec with 1 regionConfig. " +
        "Multi-region HA: 1 replicationSpec with 3+ regionConfigs (electable nodes in each, totalling >=5). " +
        "Sharded: 1 replicationSpec per shard (Independent Shard Scaling format, no numShards). " +
        "Always set autoScaling.compute and autoScaling.diskGB on every regionConfig. " +
        "For production set backupEnabled: true. " +
        "To pause after creation: poll atlas-get-cluster until stateName=='IDLE', then call " +
        "atlas-update-cluster with { paused: true }. " +
        "Defaults when replicationSpecs is omitted (DEV ONLY, not production): " +
        "REPLICASET -> single AWS US_EAST_1 M10 with autoscaling (M10-M40); " +
        "SHARDED -> two AWS US_EAST_1 M30 shards with autoscaling (M30-M60).";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID to create the cluster in"),
        ...ClusterBodyShape,
    };

    protected async execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const { projectId, ...body } = args;
        if (!body.replicationSpecs || body.replicationSpecs.length === 0) {
            const defaults = body.clusterType === "SHARDED" ? DEFAULT_SHARDED_SPECS : DEFAULT_REPLICA_SET_SPECS;
            body.replicationSpecs = defaults as unknown as typeof body.replicationSpecs;
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
