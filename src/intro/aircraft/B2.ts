import { Group, Mesh, MeshPhysicalMaterial, Vector2, Vector3, type Texture } from 'three';
import { buildB2Geometry, Z_REF } from './b2Geometry';
import { buildB2Textures } from './b2Textures';
import { ENGINE_EXHAUSTS, HALF_SPAN, upperHeight } from './planform';

export const B2_WINGSPAN = HALF_SPAN * 2;

/**
 * Procedural B-2 Spirit. The group's local frame is the flight frame:
 * +Z forward, +Y up, +X left wing.
 */
export class B2 {
  readonly object = new Group();
  readonly material: MeshPhysicalMaterial;
  /** Exhaust positions in the aircraft's local frame (contrail sources). */
  readonly exhausts: Vector3[];
  /** Wingtip positions in the local frame (used for framing metrics). */
  readonly wingtips: [Vector3, Vector3];

  private readonly mesh: Mesh;
  private readonly textures: Texture[];

  constructor(envMap: Texture | null, maxAnisotropy: number) {
    const geometry = buildB2Geometry();
    const { albedo, data } = buildB2Textures(maxAnisotropy);
    this.textures = [albedo, data];

    this.material = new MeshPhysicalMaterial({
      color: 0xffffff,
      map: albedo,
      roughnessMap: data,
      metalnessMap: data,
      bumpMap: data,
      bumpScale: 0.9,
      roughness: 1,
      metalness: 1,
      envMap,
      envMapIntensity: 0.85,
      // A thin, slightly rough clearcoat gives the RAM coating its soft sheen.
      clearcoat: 0.32,
      clearcoatRoughness: 0.3,
      specularIntensity: 0.9,
    });
    this.material.normalScale = new Vector2(1, 1);

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.object.add(this.mesh);

    this.exhausts = ENGINE_EXHAUSTS.map(([s, c]) => new Vector3(s, upperHeight(s, c + 5.5) + 0.35, Z_REF - (c + 5.5)));
    this.wingtips = [new Vector3(HALF_SPAN, 0, Z_REF - HALF_SPAN * Math.tan((33 * Math.PI) / 180)), new Vector3(-HALF_SPAN, 0, Z_REF - HALF_SPAN * Math.tan((33 * Math.PI) / 180))];
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const t of this.textures) t.dispose();
  }
}
