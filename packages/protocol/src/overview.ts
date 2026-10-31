export type ProjectPage = "overview" | "literature" | "cards" | "wiki" | "results" | "tasks";
export interface ProjectOverview {
  counts: { sources: number; accepted_cards: number; wiki_pages: number; experiment_results: number };
  pending: { unorganized_sources: number; cards: number; wiki_pages: number; stale_wiki_pages: number; unsuccessful_tasks: number };
  activities: { id: string; title: string; description: string; at: string; page: ProjectPage; object_id?: string }[];
}
