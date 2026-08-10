import type {
  CityCommunity,
  CityRepository,
  CitySnapshot,
} from "./city-schema";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface DistrictPlacement extends Point3 {
  districtId: string;
}

export interface RepositoryPlacement extends Point3 {
  repository: CityRepository;
  width: number;
  depth: number;
  height: number;
}

const DISTRICT_GRID: ReadonlyArray<readonly [number, number]> = [
  [-26, -17],
  [-9, -17],
  [9, -17],
  [26, -17],
  [-18, 12],
  [0, 12],
  [18, 12],
  [0, 31],
];

const COMMUNITY_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-3.2, -2.2],
  [3.2, -2.2],
  [-3.2, 2.2],
  [3.2, 2.2],
  [0, 0],
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function repositoriesForCommunity(
  repositories: CityRepository[],
  community: CityCommunity,
): CityRepository[] {
  return repositories
    .filter((repository) => repository.community_id === community.id)
    .toSorted((left, right) => left.repository_id - right.repository_id);
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

export function buildCityLayout(snapshot: CitySnapshot): {
  districts: DistrictPlacement[];
  repositories: RepositoryPlacement[];
} {
  const districts = snapshot.districts.map((district, index) => {
    const [x, z] = DISTRICT_GRID[index] ?? [0, 31 + (index - DISTRICT_GRID.length + 1) * 15];
    return { districtId: district.id, x, y: 0, z };
  });
  const districtById = new Map(districts.map((district) => [district.districtId, district]));
  const repositories: RepositoryPlacement[] = [];

  for (const district of snapshot.districts) {
    const districtPlacement = districtById.get(district.id);
    if (!districtPlacement) {
      continue;
    }

    const communities = snapshot.communities
      .filter((community) => community.district_id === district.id)
      .toSorted((left, right) => left.id.localeCompare(right.id));

    communities.forEach((community, communityIndex) => {
      const [communityX, communityZ] =
        COMMUNITY_OFFSETS[communityIndex % COMMUNITY_OFFSETS.length] ?? [0, 0];
      const members = repositoriesForCommunity(snapshot.repositories, community);

      members.forEach((repository, repositoryIndex) => {
        const angle = repositoryIndex * 2.3999632297;
        const radius = repositoryIndex === 0 ? 0 : 1.8 + Math.sqrt(repositoryIndex) * 1.25;
        const dimensions = calculateBuildingDimensions(repository);
        repositories.push({
          repository,
          ...dimensions,
          x: districtPlacement.x + communityX + Math.cos(angle) * radius,
          y: 0.5 + dimensions.height / 2,
          z: districtPlacement.z + communityZ + Math.sin(angle) * radius,
        });
      });
    });
  }

  return {
    districts,
    repositories: repositories.toSorted(
      (left, right) => left.repository.global_rank - right.repository.global_rank,
    ),
  };
}
