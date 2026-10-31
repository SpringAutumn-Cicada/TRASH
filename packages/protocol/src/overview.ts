export type ProjectPage = "overview" | "literature" | "cards" | "wiki" | "reproductions" | "autodl" | "experiments" | "results" | "tasks" | "chat";
export interface ProjectOverview {
  counts: { sources: number; accepted_cards: number; wiki_pages: number; experiment_results: number };
  pending: { unorganized_sources: number; cards: number; wiki_pages: number; stale_wiki_pages: number; unsuccessful_tasks: number; active_experiments: number; failed_experiments: number; pending_collection: number };
  activities: { id: string; title: string; description: string; at: string; page: ProjectPage; object_id?: string }[];
}
