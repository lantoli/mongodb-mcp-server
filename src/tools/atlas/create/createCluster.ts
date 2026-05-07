import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";
import type { AdvisoryEnvelope, Decision } from "../shared/advisoryResult.js";
import { estimateClusterCost } from "../shared/clusterCostModel.js";
import { validateClusterBody } from "../shared/clusterValidator.js";

const HA_EXAMPLE = `Multi-region HA example (1 replicationSpec, 3 regionConfigs, 7 electable nodes total):
{
  "clusterType": "REPLICASET",
  "backupEnabled": true,
  "replicationSpecs": [{
    "regionConfigs": [
      { "providerName": "AWS", "regionName": "US_EAST_1", "priority": 7,
        "electableSpecs": { "instanceSize": "M30", "nodeCount": 3 },
        "autoScaling": { "compute": { "enabled": true, "scaleDownEnabled": true, "minInstanceSize": "M30", "maxInstanceSize": "M60" }, "diskGB": { "enabled": true } } },
      { "providerName": "AWS", "regionName": "US_WEST_2", "priority": 6,
        "electableSpecs": { "instanceSize": "M30", "nodeCount": 2 },
        "autoScaling": { "compute": { "enabled": true, "scaleDownEnabled": true, "minInstanceSize": "M30", "maxInstanceSize": "M60" }, "diskGB": { "enabled": true } } },
      { "providerName": "AWS", "regionName": "US_EAST_2", "priority": 5,
        "electableSpecs": { "instanceSize": "M30", "nodeCount": 2 },
        "autoScaling": { "compute": { "enabled": true, "scaleDownEnabled": true, "minInstanceSize": "M30", "maxInstanceSize": "M60" }, "diskGB": { "enabled": true } } }
    ]
  }]
}`;

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

// Detects the largest electable/readonly/analytics tier in a body, e.g. "M30" -> 30.
// Used to auto-enable backups when the agent has clearly chosen a production sizing.
function maxInstanceTier(replicationSpecs: unknown): number {
    let max = 0;
    if (!Array.isArray(replicationSpecs)) return 0;
    for (const spec of replicationSpecs) {
        const regionConfigs = (spec as { regionConfigs?: unknown[] })?.regionConfigs;
        if (!Array.isArray(regionConfigs)) continue;
        for (const rc of regionConfigs) {
            const r = rc as {
                electableSpecs?: { instanceSize?: string };
                readOnlySpecs?: { instanceSize?: string };
                analyticsSpecs?: { instanceSize?: string };
            };
            for (const size of [
                r.electableSpecs?.instanceSize,
                r.readOnlySpecs?.instanceSize,
                r.analyticsSpecs?.instanceSize,
            ]) {
                if (typeof size !== "string" || !size.startsWith("M")) continue;
                const n = parseInt(size.slice(1), 10);
                if (Number.isFinite(n) && n > max) max = n;
            }
        }
    }
    return max;
}

export class CreateClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-cluster";
    public description =
        "Create a MongoDB Atlas cluster. The body mirrors the Atlas API ClusterDescription schema. " +
        "Pass replicationSpecs[] explicitly for any non-trivial sizing; the defaults below are dev-only. " +
        "Sizing rules: dev = M10/M20 (cheapest with autoscaling). Production = M30+. Always set " +
        "electableSpecs.nodeCount: 3 on the primary region; total electable count across regions must be odd (3, 5, 7) for replica-set quorum. " +
        "priority: use 7 on the PRIMARY region ONLY; secondary regions need lower distinct values (6, 5, ...). " +
        "Single-region: 1 replicationSpec with 1 regionConfig. " +
        "Multi-region HA: 1 replicationSpec with 3+ regionConfigs, electable nodes in EACH region (>=5 total). " +
        "Sharded: 1 replicationSpec per shard (Independent Shard Scaling format, no numShards). " +
        "Always set autoScaling.compute and autoScaling.diskGB on every regionConfig. " +
        "For production set backupEnabled: true. " +
        "To pause after creation: poll atlas-get-cluster until stateName=='IDLE' (cluster build takes a few minutes), then call atlas-update-cluster with { paused: true }. " +
        "Defaults when replicationSpecs is omitted (DEV ONLY, not production): " +
        "REPLICASET -> single AWS US_EAST_1 M10 with autoscaling (M10-M40); " +
        "SHARDED -> two AWS US_EAST_1 M30 shards with autoscaling (M30-M60).\n\n" +
        HA_EXAMPLE;
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID to create the cluster in"),
        ...ClusterBodyShape,
        // Atlas requires a cluster name on create; override the shared (optional) shape.
        name: AtlasArgs.clusterName().describe("Name of the cluster (required)"),
    };

    protected async execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const { projectId, ...body } = args;
        const decisions: Decision[] = [];
        if (!body.replicationSpecs || body.replicationSpecs.length === 0) {
            const useSharded = body.clusterType === "SHARDED";
            const defaults = useSharded ? DEFAULT_SHARDED_SPECS : DEFAULT_REPLICA_SET_SPECS;
            body.replicationSpecs = defaults as unknown as typeof body.replicationSpecs;
            decisions.push({
                field: "replicationSpecs",
                chose: useSharded ? "2x M30 sharded default" : "single AWS US_EAST_1 M10 dev default",
                because: `replicationSpecs omitted; applied ${useSharded ? "SHARDED" : "REPLICASET"} dev-only default. Override with explicit replicationSpecs for production sizing.`,
            });
        }
        // Production-aware default: when the chosen sizing is M30+, treat as production
        // and enable backups by default. The agent can still set backupEnabled: false explicitly.
        if (body.backupEnabled === undefined && maxInstanceTier(body.replicationSpecs) >= 30) {
            body.backupEnabled = true;
            decisions.push({
                field: "backupEnabled",
                chose: true,
                because: "auto-enabled because chosen instance tier is M30+; pass backupEnabled: false to override.",
            });
        }
        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        const cluster = await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body: body as unknown as ClusterDescription20240805,
        });

        const validation = validateClusterBody(body as unknown as ClusterDescription20240805);
        const envelope: AdvisoryEnvelope<ClusterDescription20240805> = {
            body: cluster,
            decisions,
            warnings: validation.issues.map((i) => `${i.level}: ${i.field}: ${i.because}`),
            estimatedMonthlyCost: estimateClusterCost(body as unknown as ClusterDescription20240805),
            issues: validation.issues,
        };

        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${body.name ?? cluster.name ?? ""}" creation requested in project ${projectId}.`,
                },
                { type: "text", text: JSON.stringify(envelope, null, 2) },
            ],
        };
    }
}
