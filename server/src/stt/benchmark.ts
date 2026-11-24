import type {
  MeetingSettings,
  SttBenchmarkRecommendation,
  SttBenchmarkResult,
} from '@atelier/contracts';
import type { SttProvider } from '../meetings/stt.js';
import { type SttInstaller, SttInstallerError } from './installer.js';
import { loadSttSampleWav } from './wav-sample.js';

export function classifyBenchmarkRatio(realtimeRatio: number): SttBenchmarkRecommendation {
  if (realtimeRatio >= 2) return 'live_safe';
  if (realtimeRatio >= 1) return 'live_tight';
  return 'economy';
}

export async function runSttBenchmark(opts: {
  installer: SttInstaller;
  provider: SttProvider;
  settings: MeetingSettings;
  modelId?: string;
}): Promise<SttBenchmarkResult> {
  const status = opts.installer.getStatus(opts.settings);
  if (!status.installedEngine) {
    throw new SttInstallerError('engine_not_installed', 'Install the Whisper engine first.', 400);
  }
  const targetModelId = opts.modelId ?? opts.settings.activeModelId;
  if (!opts.installer.getModelPath(targetModelId)) {
    throw new SttInstallerError(
      'model_not_installed',
      `Model ${targetModelId} is not downloaded yet.`,
      400,
    );
  }

  const { wav, durationSec } = loadSttSampleWav();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  timeout.unref?.();

  try {
    await opts.provider.prepare();
    const startMs = Date.now();
    await opts.provider.transcribe(wav, {
      language: opts.settings.language,
      signal: controller.signal,
    });
    const elapsedSec = Math.max(0.05, Number(((Date.now() - startMs) / 1000).toFixed(2)));
    const realtimeRatio = Number((durationSec / elapsedSec).toFixed(2));
    const result: SttBenchmarkResult = {
      engineVersion: status.installedEngine.version,
      modelId: targetModelId,
      threads: opts.settings.threads,
      useGpu: opts.settings.useGpu,
      audioDurationSec: durationSec,
      elapsedSec,
      realtimeRatio,
      recommendation: classifyBenchmarkRatio(realtimeRatio),
      measuredAt: new Date().toISOString(),
    };
    opts.installer.saveBenchmark(result);
    return result;
  } finally {
    clearTimeout(timeout);
    await opts.provider.release().catch(() => undefined);
  }
}
