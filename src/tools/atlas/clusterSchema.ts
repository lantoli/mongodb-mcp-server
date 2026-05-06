import { z } from "zod";

const InstanceSpecsSchema = z
    .object({
        instanceSize: z.string().describe("Cluster tier, e.g. M10, M30, M0."),
        nodeCount: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Required for dedicated tiers (typically 3 for electable nodes)."),
        diskSizeGB: z.number().optional(),
        diskIOPS: z.number().int().optional(),
        ebsVolumeType: z.string().optional(),
    })
    .passthrough();

const AutoScalingSchema = z
    .object({
        compute: z
            .object({
                enabled: z.boolean().optional(),
                scaleDownEnabled: z.boolean().optional(),
                minInstanceSize: z.string().optional(),
                maxInstanceSize: z.string().optional(),
            })
            .passthrough()
            .optional(),
        diskGB: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    })
    .passthrough();

const RegionConfigSchema = z
    .object({
        providerName: z.enum(["AWS", "AZURE", "GCP", "TENANT"]),
        backingProviderName: z
            .enum(["AWS", "AZURE", "GCP"])
            .optional()
            .describe("Required when providerName is TENANT."),
        regionName: z.string().describe("Cloud region, e.g. US_EAST_1, EU_WEST_1."),
        priority: z
            .number()
            .int()
            .min(0)
            .max(7)
            .optional()
            .describe(
                "Election priority. Required for dedicated tiers. Use 7 on the PRIMARY region ONLY. " +
                    "Secondary regions must use lower, distinct values (e.g. 6, 5, 4). Setting priority: 7 " +
                    "on more than one region returns HTTP 400 from Atlas."
            ),
        electableSpecs: InstanceSpecsSchema.optional(),
        readOnlySpecs: InstanceSpecsSchema.optional(),
        analyticsSpecs: InstanceSpecsSchema.optional(),
        autoScaling: AutoScalingSchema.optional(),
        analyticsAutoScaling: AutoScalingSchema.optional(),
    })
    .passthrough();

const ReplicationSpecSchema = z
    .object({
        zoneName: z.string().optional().default("Zone 1"),
        regionConfigs: z.array(RegionConfigSchema).min(1),
    })
    .passthrough();

export const ClusterBodyShape = {
    name: z.string().optional().describe("Cluster name. Required for create; cannot be changed on update."),
    clusterType: z.enum(["REPLICASET", "SHARDED", "GEOSHARDED"]).optional(),
    replicationSpecs: z
        .array(ReplicationSpecSchema)
        .optional()
        .describe(
            "One entry per shard for SHARDED clusters (Independent Shard Scaling format, no numShards). One entry for REPLICASET."
        ),
    backupEnabled: z
        .boolean()
        .optional()
        .describe(
            "Daily snapshot backups. Defaults to false. Set to true for any production cluster (required for PITR audit / disaster recovery)."
        ),
    pitEnabled: z
        .boolean()
        .optional()
        .describe("Continuous (point-in-time) backups. Requires backupEnabled: true."),
    paused: z
        .boolean()
        .optional()
        .describe(
            "Set to true to pause an IDLE cluster; false to resume. Atlas rejects pause unless stateName is IDLE, so call atlas-get-cluster first."
        ),
    terminationProtectionEnabled: z.boolean().optional(),
    mongoDBMajorVersion: z.string().optional(),
    encryptionAtRestProvider: z.enum(["NONE", "AWS", "AZURE", "GCP"]).optional(),
    replicaSetScalingStrategy: z.enum(["SEQUENTIAL", "WORKLOAD_TYPE", "NODE_TYPE"]).optional(),
    tags: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
};

export const ClusterBodySchema = z.object(ClusterBodyShape).passthrough();
