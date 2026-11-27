export interface WhisperEngineCatalogEntry {
  id: string;
  version: string;
  platform: string;
  url: string;
  host: string;
  sha256: string;
  sizeBytes: number;
  exe: string;
  gpu?: boolean;
  installMethod?: 'archive' | 'homebrew';
  formula?: string;
}

export interface WhisperModelCatalogEntry {
  id: string;
  label: string;
  filename: string;
  url: string;
  host: string;
  sha256: string;
  sizeBytes: number;
  ramMb: number;
  quality: number;
  recommended?: boolean;
}

export interface SpeakerEngineAsset {
  url: string;
  host: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * The engine that tells voices apart (sherpa-onnx offline speaker diarization): the program,
 * a segmentation model (who speaks when) and a voice-embedding model (who sounds alike).
 */
export interface SpeakerEngineCatalog {
  version: string;
  platform: string;
  engine: SpeakerEngineAsset & { exe: string };
  segmentation: SpeakerEngineAsset & { modelFile: string };
  embedding: SpeakerEngineAsset & { filename: string };
}

export interface SttCatalog {
  engines: readonly WhisperEngineCatalogEntry[];
  models: readonly WhisperModelCatalogEntry[];
  /** Optional: without it the app only separates "me" from "others". */
  speakers?: SpeakerEngineCatalog;
  /** Optional per-platform speaker diarization catalogs (preferred when matching the current OS). */
  speakersByPlatform?: readonly SpeakerEngineCatalog[];
}

export const WHISPER_ENGINES: readonly WhisperEngineCatalogEntry[] = [
  {
    id: 'cpu-x64',
    version: 'b5907',
    platform: 'win32-x64',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5907/whisper-bin-x64.zip',
    host: 'github.com',
    sha256: 'ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b',
    sizeBytes: 9168428,
    exe: 'Release/whisper-server.exe',
  },
  {
    id: 'blas-x64',
    version: 'b5907',
    platform: 'win32-x64',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5907/whisper-blas-bin-x64.zip',
    host: 'github.com',
    sha256: '98a4691eb23a3a2afe91b0773bea5b2b4bcd5e7432a49e588724e84268711f11',
    sizeBytes: 21955392,
    exe: 'Release/whisper-server.exe',
  },
  {
    id: 'metal-arm64',
    version: 'homebrew',
    platform: 'darwin-arm64',
    url: 'https://formulae.brew.sh/formula/whisper-cpp',
    host: 'homebrew',
    sha256: '',
    sizeBytes: 15000000,
    exe: 'whisper-server',
    gpu: true,
    installMethod: 'homebrew',
    formula: 'whisper-cpp',
  },
  {
    id: 'metal-x64',
    version: 'homebrew',
    platform: 'darwin-x64',
    url: 'https://formulae.brew.sh/formula/whisper-cpp',
    host: 'homebrew',
    sha256: '',
    sizeBytes: 15000000,
    exe: 'whisper-server',
    gpu: true,
    installMethod: 'homebrew',
    formula: 'whisper-cpp',
  },
];

export const WHISPER_MODELS: readonly WhisperModelCatalogEntry[] = [
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large v3 Turbo (recommended)',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    host: 'huggingface.co',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    sizeBytes: 574041195,
    ramMb: 1400,
    quality: 4,
    recommended: true,
  },
  {
    id: 'medium-q5_0',
    label: 'Medium',
    filename: 'ggml-medium-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin',
    host: 'huggingface.co',
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    sizeBytes: 539212467,
    ramMb: 1200,
    quality: 4,
  },
  {
    id: 'small-q5_1',
    label: 'Small (lightweight)',
    filename: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    host: 'huggingface.co',
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    sizeBytes: 190085487,
    ramMb: 600,
    quality: 2,
  },
  {
    id: 'base',
    label: 'Base (ultra-light)',
    filename: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    host: 'huggingface.co',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    sizeBytes: 147951465,
    ramMb: 400,
    quality: 1,
  },
];

/**
 * sherpa-onnx v2.0.3 (Apache-2.0). SHA-256 values: GitHub's release digests for the engine and
 * the embedding model; the segmentation archive had none, so it was hashed after download.
 * The segmentation model is MIT-licensed (pyannote/segmentation-3.0, converted by k2-fsa).
 * Not used on purpose: sherpa-onnx-reverb-diarization-v1 (non-commercial licence).
 */
const SPEAKER_SEGMENTATION: SpeakerEngineAsset & { modelFile: string } = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  host: 'github.com',
  sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
  sizeBytes: 6958444,
  modelFile: 'model.int8.onnx',
};

const SPEAKER_EMBEDDING: SpeakerEngineAsset & { filename: string } = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  host: 'github.com',
  sha256: 'f1ee61be04000b50392a63442e5dd9feaea7e81dddd494d3647cf1c3d88a1498',
  sizeBytes: 39593762,
  filename: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
};

export const SPEAKER_ENGINE: SpeakerEngineCatalog = {
  version: 'sherpa-onnx-v2.0.3',
  platform: 'win32-x64',
  engine: {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-v2.0.3-win-x64-shared-MD-Release-no-tts.tar.bz2',
    host: 'github.com',
    sha256: '88adaac47d3b3fe5b341634fd17f8287340d1b99e23ba1b5a57ffc0a2a38d0bc',
    sizeBytes: 26028350,
    exe: 'sherpa-onnx-offline-speaker-diarization.exe',
  },
  segmentation: SPEAKER_SEGMENTATION,
  embedding: SPEAKER_EMBEDDING,
};

export const SPEAKER_ENGINES: readonly SpeakerEngineCatalog[] = [
  SPEAKER_ENGINE,
  {
    version: 'sherpa-onnx-v2.0.3',
    platform: 'darwin-arm64',
    engine: {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-v2.0.3-osx-arm64-shared-no-tts.tar.bz2',
      host: 'github.com',
      sha256: '611aee84500fbc8a1295c05c15afeefa74380602ddc1a212e8a703cfe76981fd',
      sizeBytes: 20241643,
      exe: 'sherpa-onnx-offline-speaker-diarization',
    },
    segmentation: SPEAKER_SEGMENTATION,
    embedding: SPEAKER_EMBEDDING,
  },
  {
    version: 'sherpa-onnx-v2.0.3',
    platform: 'darwin-x64',
    engine: {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-v2.0.3-osx-x64-shared-no-tts.tar.bz2',
      host: 'github.com',
      sha256: 'd44a9a15dfd318e4db403676056fd89a4984b363dd466a74f130928eb62a325d',
      sizeBytes: 22792603,
      exe: 'sherpa-onnx-offline-speaker-diarization',
    },
    segmentation: SPEAKER_SEGMENTATION,
    embedding: SPEAKER_EMBEDDING,
  },
];

export const DEFAULT_STT_CATALOG: SttCatalog = {
  engines: WHISPER_ENGINES,
  models: WHISPER_MODELS,
  speakers: SPEAKER_ENGINE,
  speakersByPlatform: SPEAKER_ENGINES,
};

export function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function getDefaultEngineId(
  catalog: SttCatalog = DEFAULT_STT_CATALOG,
  platform: string = getPlatformKey(),
): string | null {
  const match = catalog.engines.find((e) => e.platform === platform || e.platform === 'any');
  return match?.id ?? null;
}

export function getSpeakerCatalogForPlatform(
  catalog: SttCatalog = DEFAULT_STT_CATALOG,
  platform: string = getPlatformKey(),
): SpeakerEngineCatalog | undefined {
  if (catalog.speakers && (catalog.speakers.platform === platform || catalog.speakers.platform === 'any')) {
    return catalog.speakers;
  }
  const byPlatform = catalog.speakersByPlatform?.find(
    (entry) => entry.platform === platform || entry.platform === 'any',
  );
  if (byPlatform) return byPlatform;
  return catalog.speakers;
}

export function getEngineById(
  id: string,
  catalog: SttCatalog = DEFAULT_STT_CATALOG,
): WhisperEngineCatalogEntry | undefined {
  return catalog.engines.find((e) => e.id === id);
}

export function getModelById(
  id: string,
  catalog: SttCatalog = DEFAULT_STT_CATALOG,
): WhisperModelCatalogEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

/** Ordered from heaviest to lightest to suggest a faster fallback when live transcription lags. */
const MODEL_SPEED_ORDER = ['large-v3-turbo-q5_0', 'medium-q5_0', 'small-q5_1', 'base'];

export function getSmallerInstalledModel(
  activeModelId: string,
  installedModelIds: readonly string[],
): string | null {
  const installedSet = new Set(installedModelIds);
  const activeIdx = MODEL_SPEED_ORDER.indexOf(activeModelId);
  if (activeIdx === -1) {
    // Pick the lightest installed model other than activeModelId
    for (let i = MODEL_SPEED_ORDER.length - 1; i >= 0; i -= 1) {
      const candidate = MODEL_SPEED_ORDER[i]!;
      if (candidate !== activeModelId && installedSet.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  for (let i = activeIdx + 1; i < MODEL_SPEED_ORDER.length; i += 1) {
    const candidate = MODEL_SPEED_ORDER[i]!;
    if (installedSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}
