export interface Decision {
    field: string;
    chose: unknown;
    because: string;
}

export interface CostBreakdown {
    total: number;
    compute: number;
    backup: number;
    currency: "USD";
    note: string;
}

export interface ValidationIssue {
    level: "error" | "warning";
    field: string;
    current: unknown;
    suggested: unknown;
    because: string;
}

export interface AdvisoryEnvelope<TBody = unknown> {
    body?: TBody;
    decisions: Decision[];
    warnings: string[];
    estimatedMonthlyCost?: CostBreakdown;
    issues?: ValidationIssue[];
}
