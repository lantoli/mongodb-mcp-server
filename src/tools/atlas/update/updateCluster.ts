import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import { ClusterBodyShape } from "../clusterSchema.js";
import { ApiClientError } from "../../../common/atlas/apiClientError.js";

export class UpdateClusterTool extends AtlasToolBase {
    static toolName = "atlas-update-cluster";
    public description =
        "Update an existing Atlas cluster. All body fields are OPTIONAL, send only what you want to change. " +
        "Two distinct workflows: " +
        "(1) CONFIG CHANGES (resize, region changes, backup/termination toggles, tags, etc.): call atlas-get-cluster first, " +
        "modify the returned config, and pass the FULL modified config here. The API replaces arrays like replicationSpecs and tags wholesale, " +
        "so a partial config-change body would silently clear them. " +
        "(2) PAUSE/RESUME: Atlas REJECTS requests that combine `paused` with any other config field. To pause or resume, " +
        "send ONLY { projectId, clusterName, paused: true|false }, no name, no replicationSpecs, no other fields. " +
        "Cluster must be IDLE before it can be paused; the API rejects pause requests on non-IDLE clusters, " +
        "so call atlas-get-cluster and check stateName=='IDLE' first.";
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
        // Drop undefined keys so the PATCH body contains only fields the agent set.
        const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        // Atlas rejects updates that combine `paused` with any other config field.
        // Catch this client-side to give the agent an actionable error instead of an opaque 4xx.
        if ("paused" in body) {
            const otherKeys = Object.keys(body).filter((k) => k !== "paused");
            if (otherKeys.length > 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Atlas rejects updates that combine 'paused' with other config fields. ` +
                                `Got extra fields: ${otherKeys.join(", ")}. ` +
                                `Send ONLY { projectId, clusterName, paused: ${String(body.paused)} } to pause/resume; ` +
                                `if you also need to change config, do that in a separate atlas-update-cluster call.`,
                        },
                    ],
                    isError: true,
                };
            }
        }
        const updated = await this.apiClient.updateCluster({
            params: { path: { groupId: projectId, clusterName } },
            body,
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${clusterName}" update requested (state: ${updated.stateName ?? "UPDATING"}, paused: ${updated.paused ?? false}).`,
                },
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
                            `Call atlas-get-cluster, wait until stateName === "IDLE" (cluster build/transition typically takes a few minutes), then retry.`,
                    },
                ],
                isError: true,
            };
        }
        return super.handleError(error, args);
    }
}
