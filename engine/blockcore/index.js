// blockcore/index.js
// Standalone block engine. Nothing in here knows about distance fields,
// shaders or Fieldcraft — IFScraft, Imagecraft and Mazecraft are meant to
// migrate onto this same surface.
//
// Surface:
//   VoxelGrid        sparse cells, packed integer keys, hard cell budget
//   BlockPalette     material id -> Bedrock block, plus remapping
//   meshGrid         merged face-culled mesh for preview
//   buildMcStructure .mcstructure bytes
//   splitGrid        aligned chunking + placement guide
//   buildMcPack      behaviour pack wrapper

export const BLOCKCORE_VERSION = '0.2.0';

export {
  VoxelGrid, BudgetExceededError,
  packKey, unpackKey, packValue, valueMaterial, valueShade,
  AXIS_BITS, AXIS_SPAN, AXIS_BIAS, AXIS_MIN, AXIS_MAX, inRange,
} from './voxels.js';

export {
  BlockPalette, MATERIALS, MATERIAL_COUNT, blockKey,
  DEFAULT_BLOCK_VERSION, BLOCK_VERSION_1_21_0, STRUCTURE_BLOCK_MAX,
} from './palette.js';

export { meshGrid, countExposedFaces, GREEDY_VOLUME_LIMIT } from './mesher.js';

export { buildMcStructure, EMPTY_MODE, MAX_CELLS_PER_FILE } from './mcstructure.js';

export { splitGrid, placementGuide, DEFAULT_CHUNK } from './split.js';

export { buildMcPack, buildMcPackAsync, uuid4, sanitizeId } from './mcpack.js';

export { ZipWriter, crc32, deflateAvailable } from './zip.js';

export { writeNBT, readNBT, T as NBT_TAG } from './nbt.js';
