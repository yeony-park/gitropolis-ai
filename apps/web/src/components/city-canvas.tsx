"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { buildCityLayout } from "@/lib/city-layout";
import type { CityRepository, CitySnapshot } from "@/lib/city-schema";

export interface CityHover {
  repository: CityRepository;
  clientX: number;
  clientY: number;
}

interface CityCanvasProps {
  snapshot: CitySnapshot;
  enabledDistricts: ReadonlySet<string>;
  topN: number;
  focusRepositoryId: number | null;
  onHover: (hover: CityHover | null) => void;
  onSelect: (repository: CityRepository) => void;
}

interface BuildingRecord {
  repository: CityRepository;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  beacon: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
}

interface DistrictRecord {
  districtId: string;
  material: THREE.MeshStandardMaterial;
  label: THREE.Sprite;
}

interface SceneState {
  buildings: BuildingRecord[];
  districts: DistrictRecord[];
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
): { sprite: THREE.Sprite; texture: THREE.CanvasTexture; material: THREE.SpriteMaterial } {
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
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(10.5, 1.75, 1);
  return { sprite, texture, material };
}

function disposeMaterial(material: THREE.Material): void {
  if (material instanceof THREE.SpriteMaterial) {
    material.map?.dispose();
  }
  material.dispose();
}

export function CityCanvas({
  snapshot,
  enabledDistricts,
  topN,
  focusRepositoryId,
  onHover,
  onSelect,
}: CityCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const hoverCallbackRef = useRef(onHover);
  const selectCallbackRef = useRef(onSelect);

  /* eslint-disable react-hooks/immutability -- Three.js scene objects use an imperative API. */
  useEffect(() => {
    hoverCallbackRef.current = onHover;
  }, [onHover]);

  useEffect(() => {
    selectCallbackRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030610);
    scene.fog = new THREE.FogExp2(0x030610, 0.0095);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 250);
    camera.position.set(43, 43, 57);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
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
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.minDistance = 18;
    controls.maxDistance = 125;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.target.set(0, 0, 2);

    scene.add(new THREE.HemisphereLight(0x9fc5ff, 0x050714, 1.65));
    const keyLight = new THREE.DirectionalLight(0x8cecff, 2.5);
    keyLight.position.set(28, 44, 25);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xa66cff, 1.8);
    rimLight.position.set(-30, 22, -25);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(110, 55, 0x153462, 0x0b1630);
    grid.position.y = -0.02;
    scene.add(grid);

    const starPositions = new Float32Array(1_200 * 3);
    for (let index = 0; index < 1_200; index += 1) {
      starPositions[index * 3] = (deterministicRandom(index * 3) - 0.5) * 180;
      starPositions[index * 3 + 1] = deterministicRandom(index * 3 + 1) * 80 + 10;
      starPositions[index * 3 + 2] = (deterministicRandom(index * 3 + 2) - 0.5) * 180;
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

    const layout = buildCityLayout(snapshot);
    const districtPlacements = new Map(
      layout.districts.map((placement) => [placement.districtId, placement]),
    );
    const districtRecords: DistrictRecord[] = [];

    for (const district of snapshot.districts) {
      const placement = districtPlacements.get(district.id);
      if (!placement) {
        continue;
      }

      const platformGeometry = new THREE.BoxGeometry(14, 0.45, 11);
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
      label.sprite.position.set(placement.x, 1.25, placement.z - 4.25);
      scene.add(label.sprite);
      districtRecords.push({ districtId: district.id, material: platformMaterial, label: label.sprite });
    }

    for (const community of snapshot.communities) {
      const members = layout.repositories.filter(
        (placement) => placement.repository.community_id === community.id,
      );
      if (members.length === 0) {
        continue;
      }

      const center = members.reduce(
        (sum, member) => ({ x: sum.x + member.x, z: sum.z + member.z }),
        { x: 0, z: 0 },
      );
      center.x /= members.length;
      center.z /= members.length;
      const district = snapshot.districts.find((item) => item.id === community.district_id);
      const ringGeometry = new THREE.RingGeometry(3.7, 3.78, 72);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: district?.color ?? "#94a3b8",
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(center.x, 0.46, center.z);
      scene.add(ring);

      const label = makeLabel(community.label.toUpperCase(), district?.color ?? "#94a3b8", 34);
      label.sprite.scale.set(6.6, 1.1, 1);
      label.sprite.position.set(center.x, 0.95, center.z + 3.35);
      scene.add(label.sprite);
    }

    const buildingRecords: BuildingRecord[] = [];
    for (const placement of layout.repositories) {
      const district = snapshot.districts.find(
        (item) => item.id === placement.repository.district_id,
      );
      const color = district?.color ?? "#94a3b8";
      const geometry = new THREE.BoxGeometry(placement.width, placement.height, placement.depth);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.25,
        metalness: 0.72,
        roughness: 0.26,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(placement.x, placement.y, placement.z);
      mesh.userData.repositoryId = placement.repository.repository_id;
      scene.add(mesh);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0xbdefff, transparent: true, opacity: 0.7 }),
      );
      outline.position.copy(mesh.position);
      scene.add(outline);

      const beaconGeometry = new THREE.SphereGeometry(0.16, 12, 8);
      const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xe8fbff });
      const beacon = new THREE.Mesh(beaconGeometry, beaconMaterial);
      beacon.position.set(placement.x, placement.y + placement.height / 2 + 0.34, placement.z);
      scene.add(beacon);
      buildingRecords.push({ repository: placement.repository, mesh, outline, beacon });
    }

    stateRef.current = {
      buildings: buildingRecords,
      districts: districtRecords,
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
      const visibleMeshes = buildingRecords
        .filter((record) => record.mesh.visible)
        .map((record) => record.mesh);
      const hit = raycaster.intersectObjects(visibleMeshes, false)[0];
      if (!hit) {
        return null;
      }
      const repositoryId = hit.object.userData.repositoryId as number;
      return buildingRecords.find(
        (record) => record.repository.repository_id === repositoryId,
      ) ?? null;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const record = pick(event);
      hoveredRepositoryId = record?.repository.repository_id ?? null;
      renderer.domElement.style.cursor = record ? "pointer" : "grab";
      hoverCallbackRef.current(
        record
          ? { repository: record.repository, clientX: event.clientX, clientY: event.clientY }
          : null,
      );
    };
    const handlePointerLeave = () => {
      hoveredRepositoryId = null;
      hoverCallbackRef.current(null);
    };
    const handleClick = () => {
      const record = buildingRecords.find(
        (item) => item.repository.repository_id === hoveredRepositoryId,
      );
      if (record) {
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
    const startedAt = performance.now();
    const animate = (now: number) => {
      const elapsed = (now - startedAt) / 1_000;
      for (const [index, record] of buildingRecords.entries()) {
        const pulse = 0.78 + Math.sin(elapsed * 2.1 + index) * 0.22;
        record.beacon.scale.setScalar(pulse);
      }
      controls.update();
      renderer.render(scene, camera);
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
      scene.traverse((object) => {
        const renderable = object as THREE.Mesh;
        renderable.geometry?.dispose();
        if (Array.isArray(renderable.material)) {
          renderable.material.forEach(disposeMaterial);
        } else if (renderable.material) {
          disposeMaterial(renderable.material);
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
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
      district.material.opacity = enabled ? 0.24 : 0.055;
      district.label.material.opacity = enabled ? 1 : 0.24;
    }

    for (const building of state.buildings) {
      const enabled = enabledDistricts.has(building.repository.district_id);
      const highlighted = building.repository.global_rank <= topN;
      building.mesh.visible = enabled;
      building.outline.visible = enabled;
      building.beacon.visible = enabled;
      building.mesh.material.emissiveIntensity = highlighted ? 0.5 : 0.08;
      building.mesh.material.opacity = highlighted ? 1 : 0.42;
      building.mesh.material.transparent = !highlighted;
      building.outline.material.opacity = highlighted ? 0.9 : 0.18;
      building.beacon.scale.setScalar(highlighted ? 1 : 0.55);
    }
  }, [enabledDistricts, topN]);
  /* eslint-enable react-hooks/immutability */

  useEffect(() => {
    const state = stateRef.current;
    if (!state || focusRepositoryId === null) {
      return;
    }

    const building = state.buildings.find(
      (record) => record.repository.repository_id === focusRepositoryId,
    );
    if (!building) {
      return;
    }

    const target = building.mesh.position.clone();
    state.controls.target.copy(target);
    state.camera.position.copy(target.clone().add(new THREE.Vector3(13, 12, 15)));
    state.controls.update();
  }, [focusRepositoryId]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
