import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";
import { ApiClientError } from "../../../common/atlas/apiClientError.js";

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 1800;

export class UpdateClusterTool extends AtlasToolBase {
    static toolName = "atlas-update-cluster";
    public description =
        "Update a MongoDB Atlas cluster. Pass any subset of fields to change. " +
        "Pause: { paused: true }. Resume: { paused: false }. Scale tier or change autoscaling: " +
        "modified replicationSpecs. Atlas rejects updates unless the cluster is IDLE; this tool " +
        "polls atlas-get-cluster internally and waits up to waitTimeoutSeconds (default 600s = 10 min) " +
        "for stateName == 'IDLE' before issuing the update. Set waitTimeoutSeconds: 0 to fail fast " +
        "instead of waiting.";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to update"),
        ...ClusterBodyShape,
        waitTimeoutSeconds: z
            .number()
            .int()
            .min(0)
            .max(MAX_WAIT_SECONDS)
            .optional()
            .describe(
                `Max seconds to wait for the cluster to reach IDLE before issuing the update (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). Set to 0 to skip waiting and fail fast if the cluster is not IDLE.`
            ),
    };

    protected async execute(args: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const { projectId, clusterName, waitTimeoutSeconds, ...rest } = args;
        // `name` is path-bound (clusterName); the API rejects rename attempts.
        delete (rest as { name?: string }).name;

        const waitSeconds = waitTimeoutSeconds ?? DEFAULT_WAIT_SECONDS;
        if (waitSeconds > 0) {
            const finalState = await this.waitForIdle(projectId, clusterName, waitSeconds);
            if (finalState !== "IDLE") {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Cluster "${clusterName}" did not reach IDLE within ${waitSeconds}s (last observed state: ${finalState}). Increase waitTimeoutSeconds or retry later.`,
                        },
                    ],
                    isError: true,
                };
            }
        }

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

    private async waitForIdle(
        projectId: string,
        clusterName: string,
        timeoutSeconds: number
    ): Promise<string | undefined> {
        const deadline = Date.now() + timeoutSeconds * 1000;
        let lastState: string | undefined;
        while (true) {
            const cluster = await this.apiClient.getCluster({
                params: { path: { groupId: projectId, clusterName } },
            });
            lastState = cluster.stateName;
            if (lastState === "IDLE") return lastState;
            if (Date.now() >= deadline) return lastState;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
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
                            `Increase waitTimeoutSeconds (default 600) or retry later.`,
                    },
                ],
                isError: true,
            };
        }
        return super.handleError(error, args);
    }
}
