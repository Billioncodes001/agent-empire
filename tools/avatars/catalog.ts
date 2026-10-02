// Which Rocketbox source builds which shipped avatar (ids are the ones in src/shared/outfit.ts).
import { AVATARS, type AvatarId } from '../../src/shared/outfit';

export interface AvatarSource {
  id: AvatarId;
  /** Folder under Assets/Avatars/Professions/. */
  name: string;
  /** Texture file prefix, e.g. m005. */
  prefix: string;
  /** Materials beyond body/head, by FBX material suffix (hair cards and lashes are `opacity`). */
  extras?: string[];
}

const PREFIX: Record<AvatarId, [string, string, string[]?]> = {
  'business-m01': ['Business_Male_01', 'm005', ['opacity']],
  'business-m02': ['Business_Male_02', 'm008', ['opacity']],
  'business-m03': ['Business_Male_03', 'm020', ['opacity']],
  'business-m04': ['Business_Male_04', 'm015'],
  'business-m05': ['Business_Male_05', 'm016'],
  'business-m06': ['Business_Male_06', 'm025'],
  'business-f01': ['Business_Female_01', 'f014', ['opacity']],
  'business-f02': ['Business_Female_02', 'f015', ['opacity', 'glasses']],
  'business-f03': ['Business_Female_03', 'f016', ['opacity']],
  'business-f04': ['Business_Female_04', 'f020', ['opacity']],
};

export const SOURCES: AvatarSource[] = AVATARS.map((a) => {
  const [name, prefix, extras] = PREFIX[a.id];
  return { id: a.id, name, prefix, extras };
});

/** Every file one avatar needs, relative to the repository root. */
export function sourcePaths(s: AvatarSource): { fbx: string; textures: Record<string, string> } {
  const dir = `Assets/Avatars/Professions/${s.name}`;
  const textures: Record<string, string> = {};
  for (const map of ['body_color', 'body_normal', 'head_color', 'head_normal']) textures[map] = `${dir}/Textures/${s.prefix}_${map}.tga`;
  for (const extra of s.extras ?? []) {
    if (extra === 'opacity') textures.opacity_color = `${dir}/Textures/${s.prefix}_opacity_color.tga`;
    else {
      textures[`${extra}_color`] = `${dir}/Textures/${s.prefix}_${extra}_opacity_color.tga`;
      textures[`${extra}_normal`] = `${dir}/Textures/${s.prefix}_${extra}_normal.tga`;
    }
  }
  return { fbx: `${dir}/Export/${s.name}.fbx`, textures };
}
