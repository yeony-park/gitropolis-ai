"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  buildCityLayout,
  calculateFacadeActivity,
  type RepositoryPlacement,
} from "@/lib/city-layout";
import type { CityRepository, CitySnapshot } from "@/lib/city-schema";

export interface CityHover {
  repository: CityRepository;
  clientX: number;
  clientY: number;
}

export interface CityPerformanceMetrics {
  pageVisible: boolean;
  firstRenderMs: number;
  sampleDurationMs: number;
  frameCount: number;
  meanFrameMs: number;
  medianFrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  framesPerSecond: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  loadedBuildings: number;
  visibleBuildings: number;
  pixelRatio: number;
}

declare global {
  interface Window {
    __GITROPOLIS_METRICS__?: CityPerformanceMetrics;
  }
}

interface CityCanvasProps {
  snapshot: CitySnapshot;
  enabledDistricts: ReadonlySet<string>;
  topN: number;
  focusRepositoryId: number | null;
  onHover: (hover: CityHover | null) => void;
  onSelect: (repository: CityRepository) => void;
  onMetrics?: (metrics: CityPerformanceMetrics) => void;
}

interface BuildingRecord {
  repository: CityRepository;
  placement: RepositoryPlacement;
  body: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  instanceIndex: number;
}

interface DistrictRecord {
  districtId: string;
  body: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  windows: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  platformMaterial: THREE.MeshStandardMaterial;
  label: THREE.Sprite;
  buildingCount: number;
}

interface SceneState {
  buildings: BuildingRecord[];
  buildingsById: Map<number, BuildingRecord>;
  districts: DistrictRecord[];
  selectionOutline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}

function deterministicRandom(index: number): number {
  const value = Math.sin(index * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}

function makeLabel(
  text: string,
  color: string,
  fontSize: number,
): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The browser does not support a 2D canvas context.");
  }

  canvas.width = 768;
  canvas.height = 128;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `700 ${fontSize}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.shadowColor = color;
  context.shadowBlur = 18;
  context.fillStyle = color;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(10.5, 1.75, 1);
  return sprite;
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[Math.max(0, index)] ?? 0;
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function setOutline(
  outline: THREE.LineSegments,
  record: BuildingRecord | null,
): void {
  outline.visible = record !== null && record.body.visible;
  if (!record || !record.body.visible) {
    return;
  }
  const { placement } = record;
  outline.position.set(placement.x, placement.y, placement.z);
  outline.scale.set(placement.width * 1.04, placement.height * 1.02, placement.depth * 1.04);
}

export function CityCanvas({
  snapshot,
  enabledDistricts,
  topN,
  focusRepositoryId,
  onHover,
  onSelect,
  onMetrics,
}: CityCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const hoverCallbackRef = useRef(onHover);
  const selectCallbackRef = useRef(onSelect);
  const metricsCallbackRef = useRef(onMetrics);
  const focusRepositoryIdRef = useRef(focusRepositoryId);

  /* eslint-disable react-hooks/immutability -- Three.js scene objects use an imperative API. */
  useEffect(() => {
    hoverCallbackRef.current = onHover;
  }, [onHover]);

  useEffect(() => {
    selectCallbackRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    metricsCallbackRef.current = onMetrics;
  }, [onMetrics]);

  useEffect(() => {
    focusRepositoryIdRef.current = focusRepositoryId;
  }, [focusRepositoryId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const setupStartedAt = performance.now();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030610);
    scene.fog = new THREE.FogExp2(0x030610, 0.0065);
    const layout = buildCityLayout(snapshot);
    const minX = Math.min(...layout.districts.map(({ x, width }) => x - width / 2));
    const maxX = Math.max(...layout.districts.map(({ x, width }) => x + width / 2));
    const minZ = Math.min(...layout.districts.map(({ z, depth }) => z - depth / 2));
    const maxZ = Math.max(...layout.districts.map(({ z, depth }) => z + depth / 2));
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const citySpan = Math.max(maxX - minX, maxZ - minZ, 50);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, citySpan * 6);
    camera.position.set(centerX + citySpan * 0.56, citySpan * 0.58, centerZ + citySpan * 0.72);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("aria-label", "Interactive three-dimensional Gitropolis city");
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.dampingFactor = 0.055;
    controls.minDistance = 18;
    controls.maxDistance = citySpan * 3;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.target.set(centerX, 0, centerZ);

    scene.add(new THREE.HemisphereLight(0x9fc5ff, 0x050714, 1.65));
    const keyLight = new THREE.DirectionalLight(0x8cecff, 2.5);
    keyLight.position.set(28, 44, 25);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xa66cff, 1.8);
    rimLight.position.set(-30, 22, -25);
    scene.add(rimLight);

    const gridSize = Math.ceil(citySpan + 24);
    const grid = new THREE.GridHelper(gridSize, Math.ceil(gridSize / 2), 0x153462, 0x0b1630);
    grid.position.set(centerX, -0.02, centerZ);
    scene.add(grid);

    const starPositions = new Float32Array(1_200 * 3);
    for (let index = 0; index < 1_200; index += 1) {
      starPositions[index * 3] = centerX + (deterministicRandom(index * 3) - 0.5) * citySpan * 2.4;
      starPositions[index * 3 + 1] = deterministicRandom(index * 3 + 1) * citySpan + 10;
      starPositions[index * 3 + 2] = centerZ + (deterministicRandom(index * 3 + 2) - 0.5) * citySpan * 2.4;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0x6aa8ff,
      size: 0.14,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    scene.add(new THREE.Points(starGeometry, starMaterial));

    const districtPlacements = new Map(
      layout.districts.map((placement) => [placement.districtId, placement]),
    );
    const districtRecords: DistrictRecord[] = [];
    const buildingRecords: BuildingRecord[] = [];
    const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
    const windowGeometry = new THREE.BoxGeometry(1, 1, 0.035);
    const temporaryMatrix = new THREE.Matrix4();
    const temporaryPosition = new THREE.Vector3();
    const temporaryScale = new THREE.Vector3();
    const frontWindowRotation = new THREE.Quaternion();
    const sideWindowRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, Math.PI / 2, 0),
    );
    const maximumCommits = Math.max(
      1,
      ...snapshot.repositories.map(({ commits_30d: commits }) => commits ?? 0),
    );

    for (const district of snapshot.districts) {
      const placement = districtPlacements.get(district.id);
      if (!placement) {
        continue;
      }
      const members = layout.repositories.filter(
        ({ repository }) => repository.district_id === district.id,
      );
      const platformGeometry = new THREE.BoxGeometry(placement.width, 0.45, placement.depth);
      const platformMaterial = new THREE.MeshStandardMaterial({
        color: district.color,
        emissive: district.color,
        emissiveIntensity: 0.18,
        roughness: 0.62,
        metalness: 0.38,
        transparent: true,
        opacity: 0.24,
      });
      const platform = new THREE.Mesh(platformGeometry, platformMaterial);
      platform.position.set(placement.x, 0.2, placement.z);
      scene.add(platform);
      const platformOutline = new THREE.LineSegments(
        new THREE.EdgesGeometry(platformGeometry),
        new THREE.LineBasicMaterial({ color: district.color, transparent: true, opacity: 0.58 }),
      );
      platformOutline.position.copy(platform.position);
      scene.add(platformOutline);

      const label = makeLabel(district.label, district.color, 41);
      label.position.set(placement.x, 1.25, placement.z - placement.depth / 2 + 1.2);
      scene.add(label);

      const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        emissive: district.color,
        emissiveIntensity: 0.2,
        metalness: 0.72,
        roughness: 0.26,
      });
      const body = new THREE.InstancedMesh(buildingGeometry, bodyMaterial, members.length);
      body.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const repositoryIds: number[] = [];
      members.forEach((member, instanceIndex) => {
        temporaryPosition.set(member.x, member.y, member.z);
        temporaryScale.set(member.width, member.height, member.depth);
        temporaryMatrix.compose(temporaryPosition, new THREE.Quaternion(), temporaryScale);
        body.setMatrixAt(instanceIndex, temporaryMatrix);
        body.setColorAt(instanceIndex, new THREE.Color(district.color));
        repositoryIds.push(member.repository.repository_id);
        buildingRecords.push({
          repository: member.repository,
          placement: member,
          body,
          instanceIndex,
        });
      });
      body.userData.repositoryIds = repositoryIds;
      body.instanceMatrix.needsUpdate = true;
      if (body.instanceColor) {
        body.instanceColor.needsUpdate = true;
      }
      body.computeBoundingSphere();
      scene.add(body);

      const windowCounts = members.map(({ repository }) => {
        const activity = calculateFacadeActivity(repository.commits_30d, maximumCommits);
        return Math.max(1, activity.densityLevel) * 4;
      });
      const windows = new THREE.InstancedMesh(
        windowGeometry,
        new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
        windowCounts.reduce((sum, count) => sum + count, 0),
      );
      let windowIndex = 0;
      members.forEach((member) => {
        const activity = calculateFacadeActivity(member.repository.commits_30d, maximumCommits);
        const rows = Math.max(1, activity.densityLevel);
        const activityBrightness = THREE.MathUtils.clamp(
          (activity.emissiveIntensity - 0.18) / 1.57,
          0,
          1,
        );
        const color = activity.available
          ? new THREE.Color(district.color).lerp(
              new THREE.Color(0xffffff),
              0.22 + activityBrightness * 0.72,
            )
          : new THREE.Color(0x39465c);
        for (let row = 0; row < rows; row += 1) {
          for (const column of [-1, 1]) {
            const windowWidth = Math.min(0.58, member.width * 0.26);
            const windowHeight = Math.min(0.38, member.height / (rows + 2));
            temporaryPosition.set(
              member.x + column * member.width * 0.23,
              member.y - member.height * 0.28 + (row + 1) * member.height * 0.56 / (rows + 1),
              member.z + member.depth / 2 + 0.06,
            );
            temporaryScale.set(windowWidth, windowHeight, 1);
            temporaryMatrix.compose(temporaryPosition, frontWindowRotation, temporaryScale);
            windows.setMatrixAt(windowIndex, temporaryMatrix);
            windows.setColorAt(windowIndex, color);
            windowIndex += 1;

            temporaryPosition.set(
              member.x + member.width / 2 + 0.06,
              member.y - member.height * 0.28 + (row + 1) * member.height * 0.56 / (rows + 1),
              member.z + column * member.depth * 0.23,
            );
            temporaryScale.set(Math.min(0.58, member.depth * 0.26), windowHeight, 1);
            temporaryMatrix.compose(temporaryPosition, sideWindowRotation, temporaryScale);
            windows.setMatrixAt(windowIndex, temporaryMatrix);
            windows.setColorAt(windowIndex, color);
            windowIndex += 1;
          }
        }
      });
      windows.instanceMatrix.needsUpdate = true;
      if (windows.instanceColor) {
        windows.instanceColor.needsUpdate = true;
      }
      windows.computeBoundingSphere();
      scene.add(windows);
      districtRecords.push({
        districtId: district.id,
        body,
        windows,
        platformMaterial,
        label,
        buildingCount: members.length,
      });
    }

    const selectionOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(buildingGeometry),
      new THREE.LineBasicMaterial({ color: 0xe8fbff, transparent: true, opacity: 0.95 }),
    );
    selectionOutline.visible = false;
    scene.add(selectionOutline);

    const buildingsById = new Map(
      buildingRecords.map((record) => [record.repository.repository_id, record]),
    );
    stateRef.current = {
      buildings: buildingRecords,
      buildingsById,
      districts: districtRecords,
      selectionOutline,
      camera,
      controls,
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredRepositoryId: number | null = null;
    const pick = (event: PointerEvent): BuildingRecord | null => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const visibleBodies = districtRecords
        .filter(({ body }) => body.visible)
        .map(({ body }) => body);
      const hit = raycaster.intersectObjects(visibleBodies, false)[0];
      if (!hit || hit.instanceId === undefined) {
        return null;
      }
      const repositoryIds = hit.object.userData.repositoryIds as number[];
      return buildingsById.get(repositoryIds[hit.instanceId] ?? -1) ?? null;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const record = pick(event);
      hoveredRepositoryId = record?.repository.repository_id ?? null;
      renderer.domElement.style.cursor = record ? "pointer" : "grab";
      setOutline(
        selectionOutline,
        record ?? buildingsById.get(focusRepositoryIdRef.current ?? -1) ?? null,
      );
      hoverCallbackRef.current(
        record
          ? { repository: record.repository, clientX: event.clientX, clientY: event.clientY }
          : null,
      );
    };
    const handlePointerLeave = () => {
      hoveredRepositoryId = null;
      hoverCallbackRef.current(null);
      setOutline(
        selectionOutline,
        buildingsById.get(focusRepositoryIdRef.current ?? -1) ?? null,
      );
    };
    const handleClick = () => {
      const record = buildingsById.get(hoveredRepositoryId ?? -1);
      if (record?.body.visible) {
        selectCallbackRef.current(record.repository);
      }
    };
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("click", handleClick);

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let animationFrame = 0;
    let previousFrameAt = performance.now();
    let lastMetricsAt = previousFrameAt;
    const warmupEndsAt = previousFrameAt + 5_000;
    const frameSamples: number[] = [];
    let firstRenderMs = 0;
    const animate = (now: number) => {
      controls.update();
      renderer.render(scene, camera);
      if (firstRenderMs === 0) {
        firstRenderMs = Math.max(0, now - setupStartedAt);
      }
      const frameDelta = now - previousFrameAt;
      previousFrameAt = now;
      if (document.visibilityState === "visible" && now >= warmupEndsAt && frameDelta < 250) {
        frameSamples.push(frameDelta);
        if (frameSamples.length > 900) {
          frameSamples.shift();
        }
      }
      if (now - lastMetricsAt >= 1_000 && frameSamples.length >= 30) {
        const sorted = frameSamples.toSorted((left, right) => left - right);
        const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
        const metrics: CityPerformanceMetrics = {
          pageVisible: document.visibilityState === "visible",
          firstRenderMs: roundMetric(firstRenderMs),
          sampleDurationMs: roundMetric(sorted.reduce((sum, value) => sum + value, 0)),
          frameCount: sorted.length,
          meanFrameMs: roundMetric(mean),
          medianFrameMs: roundMetric(percentile(sorted, 0.5)),
          p95FrameMs: roundMetric(percentile(sorted, 0.95)),
          p99FrameMs: roundMetric(percentile(sorted, 0.99)),
          framesPerSecond: roundMetric(1_000 / mean),
          drawCalls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          points: renderer.info.render.points,
          lines: renderer.info.render.lines,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          loadedBuildings: buildingRecords.length,
          visibleBuildings: districtRecords.reduce(
            (sum, district) => sum + (district.body.visible ? district.buildingCount : 0),
            0,
          ),
          pixelRatio: renderer.getPixelRatio(),
        };
        window.__GITROPOLIS_METRICS__ = metrics;
        metricsCallbackRef.current?.(metrics);
        lastMetricsAt = now;
      }
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        const renderable = object as THREE.Mesh;
        if (renderable.geometry) {
          geometries.add(renderable.geometry);
        }
        if (Array.isArray(renderable.material)) {
          renderable.material.forEach((material) => materials.add(material));
        } else if (renderable.material) {
          materials.add(renderable.material);
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => {
        if (material instanceof THREE.SpriteMaterial) {
          material.map?.dispose();
        }
        material.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
      delete window.__GITROPOLIS_METRICS__;
      stateRef.current = null;
    };
  }, [snapshot]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) {
      return;
    }
    for (const district of state.districts) {
      const enabled = enabledDistricts.has(district.districtId);
      district.body.visible = enabled;
      district.windows.visible = enabled;
      district.platformMaterial.opacity = enabled ? 0.24 : 0.055;
      district.label.material.opacity = enabled ? 1 : 0.24;
    }
    for (const building of state.buildings) {
      const highlighted = building.repository.global_rank <= topN;
      const district = snapshot.districts.find(
        ({ id }) => id === building.repository.district_id,
      );
      const color = new THREE.Color(district?.color ?? "#94a3b8");
      if (!highlighted) {
        color.multiplyScalar(0.24);
      }
      building.body.setColorAt(building.instanceIndex, color);
    }
    for (const district of state.districts) {
      if (district.body.instanceColor) {
        district.body.instanceColor.needsUpdate = true;
      }
    }
    const focused = state.buildingsById.get(focusRepositoryIdRef.current ?? -1) ?? null;
    setOutline(state.selectionOutline, focused);
  }, [enabledDistricts, snapshot.districts, topN]);
  /* eslint-enable react-hooks/immutability */

  useEffect(() => {
    const state = stateRef.current;
    focusRepositoryIdRef.current = focusRepositoryId;
    if (!state || focusRepositoryId === null) {
      if (state) {
        setOutline(state.selectionOutline, null);
      }
      return;
    }
    const building = state.buildingsById.get(focusRepositoryId);
    if (!building || !building.body.visible) {
      return;
    }
    setOutline(state.selectionOutline, building);
    const target = new THREE.Vector3(
      building.placement.x,
      building.placement.y,
      building.placement.z,
    );
    state.controls.target.copy(target);
    state.camera.position.copy(target.clone().add(new THREE.Vector3(13, 12, 15)));
    state.controls.update();
  }, [focusRepositoryId]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
