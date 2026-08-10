import type { CityRepository, CitySnapshot } from "./city-schema";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface DistrictPlacement extends Point3 {
  districtId: string;
  width: number;
  depth: number;
  repositoryCount: number;
}

export interface RepositoryPlacement extends Point3 {
  repository: CityRepository;
  width: number;
  depth: number;
  height: number;
}

export interface FacadeActivity {
  available: boolean;
  densityLevel: number;
  emissiveIntensity: number;
  label: string;
}

const DISTRICT_COLUMNS = 4;
const DISTRICT_GAP = 7;
const BUILDING_CELL = 5.6;
const DISTRICT_PADDING = 2.5;
const MIN_DISTRICT_WIDTH = 14;
const MIN_DISTRICT_DEPTH = 11;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateBuildingDimensions(repository: CityRepository): {
  width: number;
  depth: number;
  height: number;
} {
  return {
    height: clamp(2.8 + Math.log2(repository.watch_events_window + 1) * 1.8, 3.5, 15),
    width: clamp(1.6 + Math.log10(repository.stars + 1) * 0.5, 1.8, 4.4),
    depth: clamp(1.6 + Math.log10(repository.forks + 1) * 0.45, 1.8, 4),
  };
}

export function calculateFacadeActivity(
  commits30d: number | null,
  maximumCommits30d: number,
): FacadeActivity {
  if (commits30d === null) {
    return {
      available: false,
      densityLevel: 0,
      emissiveIntensity: 0.18,
      label: "Activity data unavailable",
    };
  }
  if (commits30d === 0) {
    return {
      available: true,
      densityLevel: 1,
      emissiveIntensity: 0.24,
      label: "0 commits in latest 30d",
    };
  }

  const normalized = Math.log1p(commits30d) / Math.log1p(Math.max(1, maximumCommits30d));
  return {
    available: true,
    densityLevel: clamp(2 + Math.floor(normalized * 3), 2, 5),
    emissiveIntensity: 0.35 + normalized * 1.4,
    label: `${commits30d} commits in latest 30d`,
  };
}

function sortedDistrictRepositories(
  snapshot: CitySnapshot,
  districtId: string,
): CityRepository[] {
  return snapshot.repositories
    .filter((repository) => repository.district_id === districtId)
    .toSorted(
      (left, right) =>
        left.community_id.localeCompare(right.community_id) ||
        left.repository_id - right.repository_id,
    );
}

function districtDimensions(repositoryCount: number): {
  columns: number;
  rows: number;
  width: number;
  depth: number;
} {
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, repositoryCount))));
  const rows = Math.max(1, Math.ceil(repositoryCount / columns));
  return {
    columns,
    rows,
    width: Math.max(MIN_DISTRICT_WIDTH, columns * BUILDING_CELL + DISTRICT_PADDING * 2),
    depth: Math.max(MIN_DISTRICT_DEPTH, rows * BUILDING_CELL + DISTRICT_PADDING * 2),
  };
}

export function buildCityLayout(snapshot: CitySnapshot): {
  districts: DistrictPlacement[];
  repositories: RepositoryPlacement[];
} {
  const districtDrafts = snapshot.districts.map((district) => {
    const members = sortedDistrictRepositories(snapshot, district.id);
    return {
      districtId: district.id,
      members,
      ...districtDimensions(members.length),
    };
  });
  const rows = Array.from(
    { length: Math.ceil(districtDrafts.length / DISTRICT_COLUMNS) },
    (_, index) => districtDrafts.slice(index * DISTRICT_COLUMNS, (index + 1) * DISTRICT_COLUMNS),
  );
  const rowDepths = rows.map((row) => Math.max(...row.map(({ depth }) => depth)));
  const totalDepth = rowDepths.reduce((sum, depth) => sum + depth, 0) +
    Math.max(0, rows.length - 1) * DISTRICT_GAP;
  let nextZ = -totalDepth / 2;
  const districts: DistrictPlacement[] = [];
  const repositories: RepositoryPlacement[] = [];

  rows.forEach((row, rowIndex) => {
    const rowWidth = row.reduce((sum, district) => sum + district.width, 0) +
      Math.max(0, row.length - 1) * DISTRICT_GAP;
    let nextX = -rowWidth / 2;
    const rowDepth = rowDepths[rowIndex] ?? MIN_DISTRICT_DEPTH;

    for (const district of row) {
      const x = nextX + district.width / 2;
      const z = nextZ + rowDepth / 2;
      districts.push({
        districtId: district.districtId,
        x,
        y: 0,
        z,
        width: district.width,
        depth: district.depth,
        repositoryCount: district.members.length,
      });

      const contentWidth = (district.columns - 1) * BUILDING_CELL;
      const contentDepth = (district.rows - 1) * BUILDING_CELL;
      district.members.forEach((repository, index) => {
        const column = index % district.columns;
        const memberRow = Math.floor(index / district.columns);
        const dimensions = calculateBuildingDimensions(repository);
        repositories.push({
          repository,
          ...dimensions,
          x: x - contentWidth / 2 + column * BUILDING_CELL,
          y: 0.5 + dimensions.height / 2,
          z: z - contentDepth / 2 + memberRow * BUILDING_CELL,
        });
      });
      nextX += district.width + DISTRICT_GAP;
    }
    nextZ += rowDepth + DISTRICT_GAP;
  });

  return {
    districts,
    repositories: repositories.toSorted(
      (left, right) => left.repository.global_rank - right.repository.global_rank,
    ),
  };
}
