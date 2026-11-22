export interface ChatDecisionOption {
  id: string;
  label: string;
  detail?: string;
  primary?: boolean;
}

export interface ChatDecision {
  id: string;
  title: string;
  description?: string;
  details?: { label: string; value: string }[];
  files?: string[];
  options: ChatDecisionOption[];
  status: "pending" | "selected" | "stale";
  option_id?: string;
  selected_at?: string;
  continuation_task_id?: string;
  reason?: string;
}
