import type { ApiErrorResponse } from '@atelier/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_MEETING_SETTINGS } from '@atelier/contracts';
import type { AtelierStore } from '../store.js';
import { runSttBenchmark } from './benchmark.js';
import { type SttInstaller, SttInstallerError } from './installer.js';
import type { LocalWhisperProvider } from './local-whisper.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

export function createSttRoutes(deps: {
  installer: SttInstaller;
  provider: LocalWhisperProvider;
  store: AtelierStore;
}): Hono {
  const { installer, provider, store } = deps;
  const app = new Hono();

  const currentMeetingSettings = () => store.getSettings().meeting ?? DEFAULT_MEETING_SETTINGS;

  app.get('/stt/local/status', (c) => {
    return c.json({ status: installer.getStatus(currentMeetingSettings()) });
  });

  app.post('/stt/local/install-engine', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ id: z.string().trim().min(1).optional() }).safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(apiError('invalid_engine_id', 'Invalid engine id.'), 400);
    }
    const engineId = parsed.data.id ?? 'cpu-x64';
    try {
      await provider.shutdown();
      const installed = await installer.installEngine(engineId);
      return c.json({
        installed,
        status: installer.getStatus(currentMeetingSettings()),
      });
    } catch (err) {
      if (err instanceof SttInstallerError) {
        return c.json(apiError(err.code, err.message), err.status);
      }
      return c.json(
        apiError('install_failed', err instanceof Error ? err.message : 'Failed to install Whisper engine.'),
        500,
      );
    }
  });

  app.post('/stt/local/models/:id/download', async (c) => {
    const id = c.req.param('id');
    try {
      const installed = await installer.downloadModel(id);
      return c.json({
        installed,
        status: installer.getStatus(currentMeetingSettings()),
      });
    } catch (err) {
      if (err instanceof SttInstallerError) {
        return c.json(apiError(err.code, err.message), err.status);
      }
      return c.json(
        apiError('download_failed', err instanceof Error ? err.message : 'Failed to download Whisper model.'),
        500,
      );
    }
  });

  app.delete('/stt/local/models/:id', async (c) => {
    const id = c.req.param('id');
    const current = currentMeetingSettings();
    if (current.activeModelId === id) {
      await provider.shutdown();
    }
    const ok = installer.deleteModel(id);
    if (!ok) {
      return c.json(apiError('model_not_found', `Model ${id} is not installed.`), 404);
    }
    return c.json({
      ok: true,
      status: installer.getStatus(currentMeetingSettings()),
    });
  });

  app.delete('/stt/local/engine', async (c) => {
    await provider.shutdown();
    installer.deleteEngine();
    return c.json({
      ok: true,
      status: installer.getStatus(currentMeetingSettings()),
    });
  });

  app.post('/stt/local/speakers/install', async (c) => {
    try {
      await installer.installSpeakerEngine();
      return c.json({ ok: true, status: installer.getStatus(currentMeetingSettings()) });
    } catch (err) {
      if (err instanceof SttInstallerError) {
        return c.json(apiError(err.code, err.message), err.status);
      }
      return c.json(
        apiError('install_failed', err instanceof Error ? err.message : 'Failed to install the speaker engine.'),
        500,
      );
    }
  });

  app.delete('/stt/local/speakers', (c) => {
    installer.deleteSpeakerEngine();
    return c.json({ ok: true, status: installer.getStatus(currentMeetingSettings()) });
  });

  app.delete('/stt/local/all', async (c) => {
    await provider.shutdown();
    await installer.clearAll();
    return c.json({
      ok: true,
      status: installer.getStatus(currentMeetingSettings()),
    });
  });

  app.post('/stt/local/cancel', async (c) => {
    const cancelled = await installer.cancelDownload();
    return c.json({
      ok: true,
      cancelled,
      status: installer.getStatus(currentMeetingSettings()),
    });
  });

  app.post('/stt/local/benchmark', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ modelId: z.string().trim().min(1).optional() }).safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(apiError('invalid_benchmark_input', 'Invalid benchmark input.'), 400);
    }
    const settings = currentMeetingSettings();
    try {
      const result = await runSttBenchmark({
        installer,
        provider,
        settings,
        modelId: parsed.data.modelId,
      });
      return c.json({
        result,
        status: installer.getStatus(currentMeetingSettings()),
      });
    } catch (err) {
      if (err instanceof SttInstallerError) {
        return c.json(apiError(err.code, err.message), err.status);
      }
      return c.json(
        apiError('benchmark_failed', err instanceof Error ? err.message : 'Speed test failed.'),
        500,
      );
    }
  });

  return app;
}
