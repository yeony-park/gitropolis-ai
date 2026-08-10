import { z } from "zod";

const cityWindowSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

const cityDistrictSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  ko: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const cityCommunitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  district_id: z.string().min(1),
  status: z.string().min(1),
  repository_count: z.number().int().nonnegative(),
  natural_building_count: z.number().int().nonnegative(),
});

const cityRepositorySchema = z.object({
  repository_id: z.number().int().positive(),
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  url: z.string().url(),
  description: z.string().nullable().optional(),
  detection_explanation: z.object({
    methodology_version: z.literal("repository-detection-explanation-v1"),
    label: z.literal("Why Gitropolis noticed it"),
    summary: z.string().min(1),
    signals: z.object({
      window_watch_events: z.number().int().nonnegative(),
      max_daily_watch_events: z.number().int().nonnegative(),
      active_days: z.number().int().nonnegative(),
      selection_rule: z.string().min(1),
      archive_coverage_complete: z.boolean(),
    }),
  }).optional(),
  district_id: z.string().min(1),
  community_id: z.string().min(1),
  ai_relevance: z.number().min(0).max(1),
  radar_status: z.string().nullable(),
  availability_status: z.string().min(1),
  breakout_status: z.string().nullable(),
  watch_events_window: z.number().int().nonnegative(),
  weekly_watch_events: z.number().int().nonnegative().nullable(),
  max_daily_watch_events: z.number().int().nonnegative().nullable(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  commits_30d: z.number().int().nonnegative().nullable(),
  contributors_count: z.number().int().nonnegative().nullable(),
  keywords: z.array(z.string().min(1)),
  flags: z.array(z.string()),
  global_rank: z.number().int().positive(),
  community_rank: z.number().int().positive(),
});

export const citySnapshotSchema = z.object({
  schema_version: z.literal("city-v1"),
  generated_at: z.string().datetime(),
  period: z.literal("weekly"),
  window: cityWindowSchema,
  methodology: z.object({
    builder: z.string().min(1),
    district_assignment: z.string().min(1),
    community_assignment: z.string().min(1),
    ai_relevance: z.string().min(1),
    repository_lifecycle: z.string().min(1),
  }),
  source: z.object({
    activity_schema_version: z.string().min(1),
    analysis_schema_version: z.string().min(1),
    lifecycle_schema_version: z.string().min(1),
    activity_coverage_complete: z.boolean(),
    analysis_coverage_complete: z.boolean(),
    lifecycle_coverage_complete: z.boolean(),
    coverage_complete: z.boolean(),
    archive_coverage_complete: z.boolean().optional(),
    metadata_coverage_complete: z.boolean().optional(),
    repositories_considered: z.number().int().nonnegative(),
    ai_related_repositories: z.number().int().nonnegative(),
    included_repositories: z.number().int().nonnegative(),
    excluded_missing_metadata: z.number().int().nonnegative(),
    metadata_collected_at: z.string().datetime().nullable().optional(),
    metadata_selection_rule: z.string().nullable().optional(),
  }),
  districts: z.array(cityDistrictSchema),
  communities: z.array(cityCommunitySchema),
  repositories: z.array(cityRepositorySchema),
  edges: z.array(z.unknown()),
  community_edges: z.array(z.unknown()),
  display: z.object({
    top_n_options: z.array(z.number().int().positive()).min(1),
    mvp_visible_budget: z.number().int().positive(),
  }),
});

export type CitySnapshot = z.infer<typeof citySnapshotSchema>;
export type CityDistrict = CitySnapshot["districts"][number];
export type CityCommunity = CitySnapshot["communities"][number];
export type CityRepository = CitySnapshot["repositories"][number];

export async function fetchCitySnapshot(
  input: RequestInfo | URL = "/data/city.json",
): Promise<CitySnapshot> {
  const response = await fetch(input);
  if (!response.ok) {
    throw new Error(`City data request failed with HTTP ${response.status}.`);
  }

  return citySnapshotSchema.parse(await response.json());
}
