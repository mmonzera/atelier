import type { ApiErrorResponse } from '@atelier/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { type MeetingService, MeetingServiceError } from './service.js';

function apiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

function handleError(err: unknown) {
  if (err instanceof MeetingServiceError) {
    return { status: err.status, body: apiError(err.code, err.message) };
  }
  return {
    status: 500 as const,
    body: apiError('meeting_error', err instanceof Error ? err.message : 'Meeting operation failed.'),
  };
}

export function createMeetingRoutes(deps: { meetingService: MeetingService }): Hono {
  const { meetingService } = deps;
  const app = new Hono();

  app.get('/meetings', (c) => {
    return c.json({
      meetings: meetingService.listMeetings(),
      active: meetingService.getActiveMeetingStatus(),
      captureAvailable: meetingService.captureAvailable,
    });
  });

  app.get('/meetings/:id', (c) => {
    const status = meetingService.getMeeting(c.req.param('id'));
    if (!status) {
      return c.json(apiError('meeting_not_found', 'Meeting not found.'), 404);
    }
    return c.json(status);
  });

  app.delete('/meetings/:id', (c) => {
    try {
      meetingService.deleteMeeting(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.patch('/meetings/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_meeting_title', 'Provide a title of 1–200 characters.'), 400);
    }
    try {
      return c.json(meetingService.renameMeeting(c.req.param('id'), parsed.data.title));
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post('/meetings/start', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        title: z.string().trim().max(200).optional(),
        mode: z.enum(['live', 'economy']).optional(),
        language: z.enum(['auto', 'id', 'en']).optional(),
        modelId: z.string().trim().min(1).max(80).optional(),
        keepAudio: z.boolean().optional(),
        prompt: z.string().max(500).optional(),
      })
      .safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(apiError('invalid_meeting_input', 'Invalid meeting start parameters.'), 400);
    }
    try {
      const result = await meetingService.startMeeting(parsed.data);
      return c.json(result, 201);
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post('/meetings/:id/chunks', async (c) => {
    const meetingId = c.req.param('id');
    let wav: Buffer | null = null;
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      if (file && typeof file === 'object' && 'arrayBuffer' in file) {
        wav = Buffer.from(await (file as Blob).arrayBuffer());
      }
    } else {
      const ab = await c.req.arrayBuffer().catch(() => null);
      if (ab && ab.byteLength > 0) {
        wav = Buffer.from(ab);
      }
    }
    if (!wav || wav.byteLength === 0) {
      return c.json(apiError('missing_audio_chunk', 'Missing WAV audio chunk.'), 400);
    }
    try {
      const result = meetingService.enqueueChunk(meetingId, wav);
      return c.json(result, 201);
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  // Answers at once (202) with the meeting already marked as finishing; transcription and notes
  // continue in the background and arrive as meeting-status events. `?wait=1` waits for the end.
  app.post('/meetings/:id/stop', async (c) => {
    const id = c.req.param('id');
    if (!meetingService.getMeeting(id)) {
      return c.json(apiError('meeting_not_found', 'Meeting not found.'), 404);
    }
    const done = meetingService.stopMeeting(id);
    if (c.req.query('wait')) {
      try {
        return c.json(await done);
      } catch (err) {
        const e = handleError(err);
        return c.json(e.body, e.status);
      }
    }
    done.catch(() => undefined); // failures end up in the meeting's status/error
    return c.json(meetingService.getMeeting(id), 202);
  });

  app.post('/meetings/:id/pause', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ paused: z.boolean() }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_pause', 'Provide { paused: boolean }.'), 400);
    }
    try {
      return c.json(meetingService.setPaused(c.req.param('id'), parsed.data.paused));
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post('/meetings/:id/discard', async (c) => {
    try {
      await meetingService.discardMeeting(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post('/meetings/:id/defer', async (c) => {
    try {
      const result = await meetingService.deferToEconomy(c.req.param('id'));
      return c.json(result);
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post('/meetings/:id/switch-model', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ modelId: z.string().trim().min(1) }).safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('invalid_model_id', 'Provide a valid modelId.'), 400);
    }
    try {
      const result = await meetingService.switchModel(c.req.param('id'), parsed.data.modelId);
      return c.json(result);
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  app.post('/meetings/:id/resume', async (c) => {
    try {
      const result = await meetingService.resumePending(c.req.param('id'));
      return c.json(result);
    } catch (err) {
      const e = handleError(err);
      return c.json(e.body, e.status);
    }
  });

  return app;
}
