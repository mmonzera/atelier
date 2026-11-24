//! Meeting audio capture.
//!
//! Records the default microphone and the system output (WASAPI loopback: what the other
//! participants say) at the same time, mixes them to 16 kHz mono and cuts the stream at a pause
//! into ~20 s WAV files. Recording never waits for transcription: each finished file is written
//! to the meeting's `incoming` folder and announced to the server, which queues it for Whisper.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde_json::json;

pub const RATE: u32 = 16_000;
const RATE_USIZE: usize = RATE as usize;
/// Energy is measured per 30 ms frame.
const FRAME: usize = 480;
/// Start looking for a pause after 18 s…
const MIN_CHUNK: usize = 18 * RATE_USIZE;
/// …and force a cut by 25 s at the quietest spot after 15 s.
const MAX_CHUNK: usize = 25 * RATE_USIZE;
const FORCED_SEARCH_FROM: usize = 15 * RATE_USIZE;
/// A pause is 300 ms of quiet frames; the cut goes in its middle.
const PAUSE_FRAMES: usize = 10;
/// A last fragment shorter than this when stopping is dropped.
const MIN_FINAL: usize = RATE_USIZE;
/// The mixer runs this far behind the wall clock so both devices have delivered their audio.
const MIX_LATENCY_SEC: f64 = 0.5;
/// More buffered audio than this means a device clock runs fast: drop the excess to resync.
const MAX_BACKLOG: usize = RATE_USIZE;

/// Sends one line to the server's stdin.
pub type Out = Arc<dyn Fn(String) + Send + Sync>;
type Buffer = Arc<Mutex<Vec<f32>>>;

// ------------------------------------------------------------------------------- resampling

/// Converts any input rate to 16 kHz by averaging the input samples that fall into each output
/// sample (a box filter, enough anti-aliasing for speech). Also upsamples low-rate headsets.
struct Resampler {
    ratio: f64,
    phase: f64,
    sum: f32,
    n: u32,
}

impl Resampler {
    fn new(in_rate: u32) -> Self {
        Self { ratio: f64::from(in_rate.max(1)) / f64::from(RATE), phase: 0.0, sum: 0.0, n: 0 }
    }

    fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        self.sum += x;
        self.n += 1;
        self.phase += 1.0;
        if self.phase >= self.ratio {
            let v = self.sum / self.n as f32;
            self.sum = 0.0;
            self.n = 0;
            while self.phase >= self.ratio {
                out.push(v);
                self.phase -= self.ratio;
            }
        }
    }
}

// ------------------------------------------------------------------------------- segmenting

fn frame_rms(samples: &[f32]) -> Vec<f32> {
    samples
        .chunks(FRAME)
        .map(|f| (f.iter().map(|v| v * v).sum::<f32>() / f.len() as f32).sqrt())
        .collect()
}

fn percentile(values: &[f32], p: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((sorted.len() - 1) as f32 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// "Quiet" relative to this chunk's own noise floor, so it works for loud and soft microphones.
fn silence_threshold(rms: &[f32]) -> f32 {
    (percentile(rms, 0.15) * 2.5).clamp(0.002, 0.03)
}

/// Nothing but background noise: not worth a Whisper run (and Whisper invents text on silence).
pub fn is_silent(samples: &[f32]) -> bool {
    percentile(&frame_rms(samples), 0.9) < 0.004
}

/// Accumulates 16 kHz audio and cuts it into chunks at pauses.
#[derive(Default)]
pub struct Segmenter {
    chunk: Vec<f32>,
}

impl Segmenter {
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.chunk.extend_from_slice(samples);
        let mut done = Vec::new();
        while let Some(cut) = self.find_cut() {
            let rest = self.chunk.split_off(cut);
            done.push(std::mem::replace(&mut self.chunk, rest));
        }
        done
    }

    /// The remaining audio when recording stops (dropped if shorter than 1 s).
    pub fn finish(&mut self) -> Option<Vec<f32>> {
        let chunk = std::mem::take(&mut self.chunk);
        (chunk.len() >= MIN_FINAL).then_some(chunk)
    }

    fn find_cut(&self) -> Option<usize> {
        if self.chunk.len() < MIN_CHUNK {
            return None;
        }
        let rms = frame_rms(&self.chunk);
        let threshold = silence_threshold(&rms);

        // First pause after 18 s.
        let mut run = 0;
        for (i, &e) in rms.iter().enumerate().skip(MIN_CHUNK / FRAME) {
            if e < threshold {
                run += 1;
                if run >= PAUSE_FRAMES {
                    let middle = i + 1 - PAUSE_FRAMES / 2;
                    return Some((middle * FRAME).min(self.chunk.len()));
                }
            } else {
                run = 0;
            }
        }

        // Nobody paused for 25 s: cut at the quietest 300 ms between 15 s and 25 s.
        if self.chunk.len() >= MAX_CHUNK {
            let from = FORCED_SEARCH_FROM / FRAME;
            let to = (MAX_CHUNK / FRAME).min(rms.len());
            let mut best = (f32::MAX, to);
            for i in from..to.saturating_sub(PAUSE_FRAMES) {
                let energy: f32 = rms[i..i + PAUSE_FRAMES].iter().sum();
                if energy < best.0 {
                    best = (energy, i + PAUSE_FRAMES / 2);
                }
            }
            return Some((best.1 * FRAME).min(self.chunk.len()));
        }
        None
    }
}

// ------------------------------------------------------------------------------- output

/// Raises quiet recordings (up to 4×) so Whisper hears soft voices; never clips.
fn normalize(samples: &mut [f32]) {
    let peak = samples.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > 0.0 && peak < 0.5 {
        let gain = (0.9 / peak).min(4.0);
        for v in samples.iter_mut() {
            *v *= gain;
        }
    }
}

pub fn write_wav(path: &Path, samples: &[f32]) -> std::io::Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + samples.len() * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        b.extend_from_slice(&v.to_le_bytes());
    }
    // Write next to it first: the server only picks up complete `.wav` files.
    let tmp = path.with_extension("wav.part");
    fs::write(&tmp, &b)?;
    fs::rename(&tmp, path)
}

// ------------------------------------------------------------------------------- devices

fn build_source<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    buf: Buffer,
    on_error: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let mut resampler = Resampler::new(config.sample_rate);
    let mut scratch: Vec<f32> = Vec::with_capacity(8192);
    let reported = Arc::new(AtomicBool::new(false));
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                scratch.clear();
                for frame in data.chunks(channels) {
                    let sum: f32 = frame.iter().map(|&v| <f32 as FromSample<T>>::from_sample_(v)).sum();
                    resampler.push(sum / frame.len() as f32, &mut scratch);
                }
                if let Ok(mut b) = buf.lock() {
                    b.extend_from_slice(&scratch);
                }
            },
            move |err: cpal::Error| {
                // Glitches (a silent loopback device reports xruns) and automatic rerouting to a
                // new default device are harmless; only report real failures, once.
                if matches!(
                    err.kind(),
                    cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied
                ) {
                    return;
                }
                if !reported.swap(true, Ordering::SeqCst) {
                    on_error(err.to_string());
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Opens the default microphone, or the default speakers in loopback mode.
fn open_source(
    host: &cpal::Host,
    loopback: bool,
    buf: Buffer,
    on_error: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<cpal::Stream, String> {
    let device = if loopback { host.default_output_device() } else { host.default_input_device() }
        .ok_or_else(|| if loopback { "tidak ada perangkat suara" } else { "tidak ada mikrofon" }.to_string())?;
    let supported = if loopback { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config = supported.config();
    let stream = match format {
        SampleFormat::F32 => build_source::<f32>(&device, config, buf, on_error),
        SampleFormat::I16 => build_source::<i16>(&device, config, buf, on_error),
        SampleFormat::I32 => build_source::<i32>(&device, config, buf, on_error),
        other => Err(format!("format audio {other} tidak didukung")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

// ------------------------------------------------------------------------------- recorder

pub struct Recorder {
    pub meeting_id: String,
    stop: Arc<AtomicBool>,
    /// While set, audio is read from the devices (so nothing piles up) but thrown away.
    paused: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Recorder {
    /// Opens the devices and starts recording. Returns warnings (e.g. no microphone, but the
    /// laptop sound is recorded) to pass on once the server knows capture has started.
    pub fn start(meeting_id: String, dir: PathBuf, out: Out) -> Result<(Self, Vec<String>), String> {
        fs::create_dir_all(&dir).map_err(|e| format!("Folder rekaman tidak bisa dibuat: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Vec<String>, String>>();
        let thread = {
            let stop = stop.clone();
            let paused = paused.clone();
            let id = meeting_id.clone();
            std::thread::Builder::new()
                .name("meeting-audio".into())
                .spawn(move || run(id, dir, out, stop, paused, ready_tx))
                .map_err(|e| e.to_string())?
        };
        match ready_rx.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(warnings)) => Ok((Self { meeting_id, stop, paused, thread: Some(thread) }, warnings)),
            Ok(Err(err)) => {
                let _ = thread.join();
                Err(err)
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err("Perangkat audio tidak merespons.".into())
            }
        }
    }

    /// Pauses or resumes recording without closing the devices.
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    /// Stops recording; the audio since the last pause is written as a final chunk first.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(
    meeting_id: String,
    dir: PathBuf,
    out: Out,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<Vec<String>, String>>,
) {
    let host = cpal::default_host();
    let warn: Arc<dyn Fn(String) + Send + Sync> = {
        let out = out.clone();
        let id = meeting_id.clone();
        Arc::new(move |message: String| {
            out(format!("audio-error {}", json!({ "meetingId": id, "message": message, "fatal": false })));
        })
    };

    let mic_buf: Buffer = Arc::new(Mutex::new(Vec::new()));
    let sys_buf: Buffer = Arc::new(Mutex::new(Vec::new()));
    let mic = open_source(&host, false, mic_buf.clone(), {
        let warn = warn.clone();
        Arc::new(move |e| warn(format!("Mikrofon bermasalah: {e}")))
    });
    let sys = open_source(&host, true, sys_buf.clone(), {
        let warn = warn.clone();
        Arc::new(move |e| warn(format!("Rekaman suara laptop bermasalah: {e}")))
    });

    let mut warnings = Vec::new();
    match (&mic, &sys) {
        (Err(m), Err(s)) => {
            let _ = ready.send(Err(format!(
                "Tidak bisa merekam. Mikrofon: {m}. Suara laptop: {s}. Periksa Settings Windows → Privacy → Microphone."
            )));
            return;
        }
        (Err(m), Ok(_)) => warnings.push(format!(
            "Mikrofon tidak bisa direkam ({m}). Hanya suara laptop (peserta lain) yang dicatat."
        )),
        (Ok(_), Err(s)) => warnings.push(format!(
            "Suara laptop tidak bisa direkam ({s}). Hanya mikrofon yang dicatat."
        )),
        _ => {}
    }
    let _ = ready.send(Ok(warnings));

    let sources: Vec<&Buffer> = [(mic.is_ok(), &mic_buf), (sys.is_ok(), &sys_buf)]
        .into_iter()
        .filter_map(|(ok, b)| ok.then_some(b))
        .collect();

    let started = Instant::now();
    let mut produced: u64 = 0;
    let mut segmenter = Segmenter::default();
    let mut seq: u32 = 0;
    let mut mix: Vec<f32> = Vec::new();

    let mut emit = |mut chunk: Vec<f32>| {
        if is_silent(&chunk) {
            return;
        }
        normalize(&mut chunk);
        seq += 1;
        let path = dir.join(format!("{seq:05}.wav"));
        match write_wav(&path, &chunk) {
            Ok(()) => out(format!(
                "audio-chunk {}",
                json!({
                    "meetingId": meeting_id,
                    "path": path.to_string_lossy(),
                    "seconds": chunk.len() as f64 / f64::from(RATE),
                })
            )),
            Err(e) => warn(format!("Potongan audio tidak bisa disimpan: {e}")),
        }
    };

    loop {
        let stopping = stop.load(Ordering::SeqCst);
        if !stopping {
            std::thread::sleep(Duration::from_millis(200));
        }

        // How much audio to mix now: follow the wall clock (a silent loopback device delivers
        // nothing at all), or everything that is left once stopping.
        let n = if stopping {
            sources.iter().map(|b| b.lock().map(|b| b.len()).unwrap_or(0)).max().unwrap_or(0)
        } else {
            let elapsed = (started.elapsed().as_secs_f64() - MIX_LATENCY_SEC).max(0.0);
            ((elapsed * f64::from(RATE)) as u64).saturating_sub(produced) as usize
        };

        if n > 0 {
            mix.clear();
            mix.resize(n, 0.0);
            for buf in &sources {
                let Ok(mut b) = buf.lock() else { continue };
                let take = n.min(b.len());
                for (slot, v) in mix.iter_mut().zip(b.drain(..take)) {
                    *slot += v;
                }
                if !stopping && b.len() > MAX_BACKLOG {
                    let excess = b.len() - MAX_BACKLOG / 2;
                    b.drain(..excess);
                }
            }
            for v in mix.iter_mut() {
                *v = v.clamp(-1.0, 1.0);
            }
            produced += n as u64;
            if !paused.load(Ordering::SeqCst) {
                // Loudness per 100 ms for the live waveform in the UI (a few numbers, 5× a second).
                if !stopping {
                    let levels: Vec<f32> = mix
                        .chunks(RATE_USIZE / 10)
                        .map(|c| ((c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt() * 1000.0).round() / 1000.0)
                        .collect();
                    out(format!("audio-level {}", json!({ "meetingId": meeting_id, "levels": levels })));
                }
                for chunk in segmenter.push(&mix) {
                    emit(chunk);
                }
            }
        }

        if stopping {
            if let Some(chunk) = segmenter.finish() {
                emit(chunk);
            }
            break;
        }
    }
    drop(mic);
    drop(sys);
}

// ------------------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f32, amp: f32) -> Vec<f32> {
        let n = (seconds * RATE as f32) as usize;
        (0..n).map(|i| (i as f32 * 0.07).sin() * amp).collect()
    }

    fn quiet(seconds: f32) -> Vec<f32> {
        vec![0.0005; (seconds * RATE as f32) as usize]
    }

    #[test]
    fn resampler_converts_rates() {
        for in_rate in [8_000u32, 16_000, 44_100, 48_000] {
            let mut r = Resampler::new(in_rate);
            let mut out = Vec::new();
            for _ in 0..in_rate {
                r.push(0.5, &mut out);
            }
            let diff = (out.len() as i64 - RATE as i64).abs();
            assert!(diff <= 1, "{in_rate} Hz gave {} samples", out.len());
            assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-6));
        }
    }

    #[test]
    fn cuts_at_the_first_pause_after_18_seconds() {
        let mut audio = tone(19.0, 0.3);
        audio.extend(quiet(0.6));
        audio.extend(tone(5.0, 0.3));
        let mut seg = Segmenter::default();
        let chunks = seg.push(&audio);
        assert_eq!(chunks.len(), 1);
        let secs = chunks[0].len() as f32 / RATE as f32;
        assert!((19.0..19.6).contains(&secs), "cut at {secs}s");
        // Nothing is lost: the rest stays for the next chunk.
        let rest = seg.finish().unwrap();
        assert_eq!(chunks[0].len() + rest.len(), audio.len());
    }

    #[test]
    fn ignores_pauses_before_18_seconds() {
        let mut audio = tone(10.0, 0.3);
        audio.extend(quiet(1.0));
        audio.extend(tone(6.0, 0.3));
        let mut seg = Segmenter::default();
        assert!(seg.push(&audio).is_empty());
    }

    #[test]
    fn forces_a_cut_by_25_seconds_at_the_quietest_spot() {
        let mut audio = tone(20.0, 0.3);
        audio.extend(tone(0.4, 0.05)); // softer moment, not silent
        audio.extend(tone(10.0, 0.3));
        let mut seg = Segmenter::default();
        let chunks = seg.push(&audio);
        assert_eq!(chunks.len(), 1);
        let secs = chunks[0].len() as f32 / RATE as f32;
        assert!((19.8..20.6).contains(&secs), "cut at {secs}s");
    }

    #[test]
    fn drops_tiny_final_fragment_and_detects_silence() {
        let mut seg = Segmenter::default();
        seg.push(&tone(0.5, 0.3));
        assert!(seg.finish().is_none());
        assert!(is_silent(&quiet(20.0)));
        assert!(!is_silent(&tone(20.0, 0.1)));
    }

    /// Opens the real microphone and loopback for 3 s. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn opens_real_devices() {
        let dir = std::env::temp_dir().join(format!("atelier-live-{}", std::process::id()));
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let out: Out = Arc::new(move |l| sink.lock().unwrap().push(l));
        let (rec, warnings) = Recorder::start("mtg_test".into(), dir.clone(), out).expect("devices open");
        println!("warnings: {warnings:?}");
        std::thread::sleep(Duration::from_secs(3));
        rec.stop();
        println!("lines: {:?}", lines.lock().unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_a_valid_wav() {
        let dir = std::env::temp_dir().join(format!("atelier-wav-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("00001.wav");
        write_wav(&path, &tone(1.0, 0.3)).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(bytes.len(), 44 + RATE as usize * 2);
        assert!(!dir.join("00001.wav.part").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
