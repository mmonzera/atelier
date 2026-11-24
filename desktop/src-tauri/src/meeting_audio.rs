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

/// Devices to record: `None` follows the Windows defaults.
#[derive(Clone, Default, Debug)]
pub struct Devices {
    pub mic: Option<String>,
    pub speaker: Option<String>,
}

fn dev_name(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_string()).unwrap_or_default()
}

/// The device called `wanted`, else the Windows default (with a warning when the name is gone).
fn pick_device(host: &cpal::Host, loopback: bool, wanted: Option<&str>) -> (Option<cpal::Device>, Option<String>) {
    let default = || if loopback { host.default_output_device() } else { host.default_input_device() };
    let Some(name) = wanted.map(str::trim).filter(|n| !n.is_empty()) else {
        return (default(), None);
    };
    let all: Vec<cpal::Device> = if loopback {
        host.output_devices().map(|i| i.collect()).unwrap_or_default()
    } else {
        host.input_devices().map(|i| i.collect()).unwrap_or_default()
    };
    if let Some(found) = all.into_iter().find(|d| dev_name(d) == name) {
        return (Some(found), None);
    }
    (default(), Some(format!("Perangkat \"{name}\" tidak ditemukan; memakai default Windows.")))
}

pub struct OpenedSource {
    /// Owned only to keep the device open: audio stops when the stream is dropped.
    #[allow(dead_code)]
    pub stream: cpal::Stream,
    pub name: String,
    pub warning: Option<String>,
}

/// Opens a microphone, or a speaker in loopback mode (what the other participants say).
fn open_source(
    host: &cpal::Host,
    loopback: bool,
    wanted: Option<&str>,
    buf: Buffer,
    on_error: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<OpenedSource, String> {
    let (device, warning) = pick_device(host, loopback, wanted);
    let device =
        device.ok_or_else(|| if loopback { "tidak ada perangkat suara" } else { "tidak ada mikrofon" }.to_string())?;
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
    Ok(OpenedSource { stream, name: dev_name(&device), warning })
}

/// Input and output devices, for the pickers in Settings.
pub fn list_devices() -> serde_json::Value {
    let host = cpal::default_host();
    let default_in = host.default_input_device().map(|d| dev_name(&d));
    let default_out = host.default_output_device().map(|d| dev_name(&d));
    let entries = |devices: Vec<cpal::Device>, default: &Option<String>| -> Vec<serde_json::Value> {
        let mut seen = Vec::<String>::new();
        let mut out = Vec::new();
        for d in devices {
            let name = dev_name(&d);
            if name.is_empty() || seen.contains(&name) {
                continue;
            }
            out.push(json!({ "name": name, "isDefault": default.as_deref() == Some(name.as_str()) }));
            seen.push(name);
        }
        out
    };
    let inputs = host.input_devices().map(|i| i.collect()).unwrap_or_default();
    let outputs = host.output_devices().map(|i| i.collect()).unwrap_or_default();
    json!({ "inputs": entries(inputs, &default_in), "outputs": entries(outputs, &default_out) })
}

fn rms_of(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|v| v * v).sum::<f32>() / samples.len() as f32).sqrt()
}

// ------------------------------------------------------------------------------- level meter

/// Opens the chosen devices without recording, and reports their loudness ~8× a second, so the
/// user can see in Settings which microphone really delivers sound.
pub struct Meter {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Meter {
    pub fn start(devices: Devices, out: Out) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("meeting-meter".into())
                .spawn(move || meter_run(devices, out, stop))
                .ok()
        };
        Self { stop, thread }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn meter_run(devices: Devices, out: Out, stop: Arc<AtomicBool>) {
    let host = cpal::default_host();
    let mic_buf: Buffer = Arc::new(Mutex::new(Vec::new()));
    let sys_buf: Buffer = Arc::new(Mutex::new(Vec::new()));
    let quiet: Arc<dyn Fn(String) + Send + Sync> = Arc::new(|_| {});
    let mic = open_source(&host, false, devices.mic.as_deref(), mic_buf.clone(), quiet.clone());
    let sys = open_source(&host, true, devices.speaker.as_deref(), sys_buf.clone(), quiet);
    let mic_error = mic.as_ref().err().cloned();
    let sys_error = sys.as_ref().err().cloned();
    let mut first = true;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(120));
        let take = |buf: &Buffer| -> Vec<f32> { buf.lock().map(|mut b| std::mem::take(&mut *b)).unwrap_or_default() };
        let (m, s) = (take(&mic_buf), take(&sys_buf));
        let mut payload = json!({ "mic": rms_of(&m), "speaker": rms_of(&s) });
        if first {
            first = false;
            payload["micError"] = json!(mic_error);
            payload["speakerError"] = json!(sys_error);
            payload["micName"] = json!(mic.as_ref().ok().map(|o| o.name.clone()));
            payload["speakerName"] = json!(sys.as_ref().ok().map(|o| o.name.clone()));
        }
        out(format!("audio-meter {payload}"));
    }
}

// ------------------------------------------------------------------------------- energy

/// Loudness of the microphone and of the laptop sound per 100 ms, along the recording timeline.
/// Written next to every chunk so the server can tell "me" (loud mic) from "others" (loud laptop
/// sound) for each sentence.
const ENERGY_FRAME: usize = RATE_USIZE / 10;

#[derive(Default)]
pub struct Energy {
    mic: Vec<f32>,
    sys: Vec<f32>,
    /// Absolute index of the first stored frame.
    base: usize,
    acc_mic: f64,
    acc_sys: f64,
    acc_n: usize,
}

impl Energy {
    pub fn push(&mut self, mic: &[f32], sys: &[f32]) {
        for (m, s) in mic.iter().zip(sys.iter()) {
            self.acc_mic += f64::from(*m) * f64::from(*m);
            self.acc_sys += f64::from(*s) * f64::from(*s);
            self.acc_n += 1;
            if self.acc_n == ENERGY_FRAME {
                self.close_frame();
            }
        }
    }

    fn close_frame(&mut self) {
        let n = self.acc_n.max(1) as f64;
        self.mic.push((self.acc_mic / n).sqrt() as f32);
        self.sys.push((self.acc_sys / n).sqrt() as f32);
        self.acc_mic = 0.0;
        self.acc_sys = 0.0;
        self.acc_n = 0;
    }

    /// Closes the last, partly filled frame (when recording stops).
    pub fn flush(&mut self) {
        if self.acc_n > 0 {
            self.close_frame();
        }
    }

    /// Frames covering the samples `[start, end)`, then forgets everything before `end`.
    pub fn take(&mut self, start: u64, end: u64) -> (Vec<f32>, Vec<f32>) {
        let first = (start as usize / ENERGY_FRAME).max(self.base);
        let last = (end as usize).div_ceil(ENERGY_FRAME);
        let stored_end = self.base + self.mic.len();
        let (a, b) = (first.min(stored_end), last.min(stored_end));
        let round = |v: &[f32]| v.iter().map(|x| (x * 10_000.0).round() / 10_000.0).collect::<Vec<f32>>();
        let result = if b > a {
            (round(&self.mic[a - self.base..b - self.base]), round(&self.sys[a - self.base..b - self.base]))
        } else {
            (Vec::new(), Vec::new())
        };
        // Keep the frame the next chunk may start in.
        let forget_to = ((end as usize) / ENERGY_FRAME).min(stored_end);
        if forget_to > self.base {
            let drop_n = forget_to - self.base;
            self.mic.drain(..drop_n);
            self.sys.drain(..drop_n);
            self.base = forget_to;
        }
        result
    }
}

/// One-pole high-pass at ~80 Hz: removes the rumble and desk thumps of a microphone, which would
/// otherwise count as "me talking" and make Whisper hear noise.
#[derive(Default)]
struct HighPass {
    prev_in: f32,
    prev_out: f32,
}

impl HighPass {
    const ALPHA: f32 = 0.9696; // RC / (RC + 1/16000) with fc = 80 Hz

    fn apply(&mut self, samples: &mut [f32]) {
        for v in samples.iter_mut() {
            let x = *v;
            let y = Self::ALPHA * (self.prev_out + x - self.prev_in);
            self.prev_in = x;
            self.prev_out = y;
            *v = y;
        }
    }
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
    pub fn start(
        meeting_id: String,
        dir: PathBuf,
        out: Out,
        devices: Devices,
    ) -> Result<(Self, Vec<String>), String> {
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
                .spawn(move || run(id, dir, out, devices, stop, paused, ready_tx))
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

/// Writes finished chunks (audio + energy) and tells the server about them.
struct ChunkWriter {
    dir: PathBuf,
    out: Out,
    meeting_id: String,
    seq: u32,
}

impl ChunkWriter {
    /// `start` is the chunk's first sample on the recording timeline. Silent chunks are skipped
    /// (Whisper invents text on silence), but the caller still advances the timeline.
    fn write(&mut self, mut chunk: Vec<f32>, start: u64, energy: &mut Energy, warn: &dyn Fn(String)) {
        let end = start + chunk.len() as u64;
        let (mic, sys) = energy.take(start, end);
        if is_silent(&chunk) {
            return;
        }
        normalize(&mut chunk);
        self.seq += 1;
        let wav = self.dir.join(format!("{:05}.wav", self.seq));
        let energy_path = self.dir.join(format!("{:05}.energy.json", self.seq));
        let start_sec = start as f64 / f64::from(RATE);
        let energy_json = json!({
            "frameMs": 100,
            "startSec": start_sec,
            "firstFrame": start as usize / ENERGY_FRAME,
            "mic": mic,
            "speaker": sys,
        });
        let energy_ok = fs::write(&energy_path, energy_json.to_string()).is_ok();
        match write_wav(&wav, &chunk) {
            Ok(()) => (self.out)(format!(
                "audio-chunk {}",
                json!({
                    "meetingId": self.meeting_id,
                    "path": wav.to_string_lossy(),
                    "seconds": chunk.len() as f64 / f64::from(RATE),
                    "startSec": start_sec,
                    "energyPath": energy_ok.then(|| energy_path.to_string_lossy().to_string()),
                })
            )),
            Err(e) => warn(format!("Potongan audio tidak bisa disimpan: {e}")),
        }
    }
}

/// How long to wait before concluding that the microphone delivers nothing.
const MIC_CHECK_AFTER: Duration = Duration::from_secs(6);

fn run(
    meeting_id: String,
    dir: PathBuf,
    out: Out,
    devices: Devices,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<Vec<String>, String>>,
) {
    let host = cpal::default_host();
    let warn_code = {
        let out = out.clone();
        let id = meeting_id.clone();
        move |code: Option<&str>, message: String| {
            out(format!(
                "audio-error {}",
                json!({ "meetingId": id, "message": message, "fatal": false, "code": code })
            ));
        }
    };
    let warn_plain: Arc<dyn Fn(String) + Send + Sync> = {
        let out = out.clone();
        let id = meeting_id.clone();
        Arc::new(move |message: String| {
            out(format!("audio-error {}", json!({ "meetingId": id, "message": message, "fatal": false })));
        })
    };

    let mic_buf: Buffer = Arc::new(Mutex::new(Vec::new()));
    let sys_buf: Buffer = Arc::new(Mutex::new(Vec::new()));
    let mic = open_source(&host, false, devices.mic.as_deref(), mic_buf.clone(), {
        let warn = warn_plain.clone();
        Arc::new(move |e| warn(format!("Mikrofon bermasalah: {e}")))
    });
    let sys = open_source(&host, true, devices.speaker.as_deref(), sys_buf.clone(), {
        let warn = warn_plain.clone();
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
    for opened in [mic.as_ref().ok(), sys.as_ref().ok()].into_iter().flatten() {
        if let Some(w) = &opened.warning {
            warnings.push(w.clone());
        }
    }
    let _ = ready.send(Ok(warnings));

    let mic_name = mic.as_ref().ok().map(|o| o.name.clone());
    let mic_ok = mic.is_ok();
    let sys_ok = sys.is_ok();

    let started = Instant::now();
    let mut produced: u64 = 0; // samples taken from the devices (wall clock)
    let mut fed: u64 = 0; // samples on the recording timeline (pauses excluded)
    let mut emitted: u64 = 0; // timeline samples already cut into chunks
    let mut segmenter = Segmenter::default();
    let mut energy = Energy::default();
    let mut writer = ChunkWriter { dir, out: out.clone(), meeting_id: meeting_id.clone(), seq: 0 };
    let mut hp = HighPass::default();
    let mut mic_real: u64 = 0;
    let mut mic_peak: f32 = 0.0;
    let mut mic_checked = false;

    let take = |buf: &Buffer, n: usize, stopping: bool| -> (Vec<f32>, usize) {
        let mut part = vec![0.0f32; n];
        let mut real = 0;
        if let Ok(mut b) = buf.lock() {
            real = n.min(b.len());
            for (slot, v) in part.iter_mut().zip(b.drain(..real)) {
                *slot = v;
            }
            if !stopping && b.len() > MAX_BACKLOG {
                let excess = b.len() - MAX_BACKLOG / 2;
                b.drain(..excess);
            }
        }
        (part, real)
    };

    loop {
        let stopping = stop.load(Ordering::SeqCst);
        if !stopping {
            std::thread::sleep(Duration::from_millis(200));
        }

        // How much audio to take now: follow the wall clock (a silent loopback device delivers
        // nothing at all), or everything that is left once stopping.
        let n = if stopping {
            let len = |b: &Buffer| b.lock().map(|b| b.len()).unwrap_or(0);
            [(mic_ok, &mic_buf), (sys_ok, &sys_buf)]
                .into_iter()
                .filter(|(ok, _)| *ok)
                .map(|(_, b)| len(b))
                .max()
                .unwrap_or(0)
        } else {
            let elapsed = (started.elapsed().as_secs_f64() - MIX_LATENCY_SEC).max(0.0);
            ((elapsed * f64::from(RATE)) as u64).saturating_sub(produced) as usize
        };

        if n > 0 {
            let (mut mic_part, mic_taken) = if mic_ok { take(&mic_buf, n, stopping) } else { (vec![0.0; n], 0) };
            let (sys_part, _) = if sys_ok { take(&sys_buf, n, stopping) } else { (vec![0.0; n], 0) };
            mic_real += mic_taken as u64;
            mic_peak = mic_part.iter().take(mic_taken).fold(mic_peak, |m, v| m.max(v.abs()));
            hp.apply(&mut mic_part);
            produced += n as u64;

            if !paused.load(Ordering::SeqCst) {
                let mix: Vec<f32> = mic_part.iter().zip(sys_part.iter()).map(|(a, b)| (a + b).clamp(-1.0, 1.0)).collect();
                energy.push(&mic_part, &sys_part);
                // Loudness per 100 ms for the live waveform in the UI (a few numbers, 5× a second).
                if !stopping {
                    let levels: Vec<f32> = mix
                        .chunks(RATE_USIZE / 10)
                        .map(|c| (rms_of(c) * 1000.0).round() / 1000.0)
                        .collect();
                    out(format!("audio-level {}", json!({ "meetingId": meeting_id, "levels": levels })));
                }
                fed += n as u64;
                for chunk in segmenter.push(&mix) {
                    let len = chunk.len() as u64;
                    writer.write(chunk, emitted, &mut energy, &warn_plain.as_ref());
                    emitted += len;
                }
            }
        }

        // Windows happily "opens" a microphone that never delivers sound (a camera's mic, a phone
        // mic app that is not connected). Tell the user instead of recording silence all meeting.
        if !stopping && !mic_checked && mic_ok && started.elapsed() >= MIC_CHECK_AFTER {
            mic_checked = true;
            let name = mic_name.clone().unwrap_or_else(|| "mikrofon".into());
            if mic_real == 0 {
                warn_code(
                    Some("mic_silent"),
                    format!("Mikrofon \"{name}\" tidak mengirim data sama sekali. Pilih mikrofon lain di Settings → Meeting."),
                );
            } else if mic_peak == 0.0 {
                warn_code(
                    Some("mic_silent"),
                    format!("Mikrofon \"{name}\" hanya mengirim keheningan. Pilih mikrofon lain di Settings → Meeting."),
                );
            }
        }

        if stopping {
            energy.flush();
            if let Some(chunk) = segmenter.finish() {
                writer.write(chunk, emitted, &mut energy, &warn_plain.as_ref());
            }
            let _ = fed;
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

    /// Prints the devices and whether each input delivers sound (2 s each).
    /// Run with `cargo test print_devices -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_devices() {
        println!("{}", list_devices());
        let host = cpal::default_host();
        for d in host.input_devices().unwrap() {
            let buf: Buffer = Arc::new(Mutex::new(Vec::new()));
            let name = dev_name(&d);
            let Ok(cfg) = d.default_input_config() else { continue };
            let on_err: Arc<dyn Fn(String) + Send + Sync> = Arc::new(|e| println!("  error: {e}"));
            let stream = match cfg.sample_format() {
                SampleFormat::F32 => build_source::<f32>(&d, cfg.config(), buf.clone(), on_err),
                SampleFormat::I16 => build_source::<i16>(&d, cfg.config(), buf.clone(), on_err),
                _ => continue,
            };
            let Ok(stream) = stream else { println!("{name}: cannot open"); continue };
            let _ = stream.play();
            std::thread::sleep(Duration::from_secs(2));
            drop(stream);
            let samples = buf.lock().unwrap().clone();
            let rms = frame_rms(&samples);
            println!(
                "LEVEL {name}: {} samples in 2 s, median RMS {:.4}, peak {:.4}",
                samples.len(),
                percentile(&rms, 0.5),
                rms.iter().cloned().fold(0.0f32, f32::max)
            );
        }
    }

    /// Opens the real microphone and loopback for 3 s. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn opens_real_devices() {
        let dir = std::env::temp_dir().join(format!("atelier-live-{}", std::process::id()));
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let out: Out = Arc::new(move |l| sink.lock().unwrap().push(l));
        // ATELIER_TEST_MIC picks a microphone by name; unset follows the Windows default.
        let devices = Devices { mic: std::env::var("ATELIER_TEST_MIC").ok(), speaker: None };
        let (rec, warnings) = Recorder::start("mtg_test".into(), dir.clone(), out, devices).expect("devices open");
        println!("warnings: {warnings:?}");
        std::thread::sleep(Duration::from_secs(8));
        rec.stop();
        for l in lines.lock().unwrap().iter().filter(|l| l.starts_with("audio-error") || l.starts_with("audio-chunk")) {
            println!("{l}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn energy_frames_follow_the_timeline() {
        let mut e = Energy::default();
        // 1 s of loud mic over a quiet speaker, then 1 s of the opposite.
        let loud = vec![0.5f32; RATE_USIZE];
        let quiet = vec![0.01f32; RATE_USIZE];
        e.push(&loud, &quiet);
        e.push(&quiet, &loud);
        e.flush();
        // A chunk covering the second second only.
        let (mic, sys) = e.take(RATE_USIZE as u64, 2 * RATE_USIZE as u64);
        assert_eq!(mic.len(), 10);
        assert!(mic.iter().all(|v| *v < 0.05), "mic is quiet in the second second");
        assert!(sys.iter().all(|v| *v > 0.4), "speaker is loud in the second second");
        // Earlier frames are forgotten, later ones are still available.
        let (mic2, _) = e.take(0, RATE_USIZE as u64);
        assert!(mic2.is_empty());
    }

    #[test]
    fn high_pass_removes_dc_but_keeps_speech_band() {
        let mut hp = HighPass::default();
        let mut dc = vec![0.3f32; RATE_USIZE];
        hp.apply(&mut dc);
        assert!(dc[RATE_USIZE - 1].abs() < 0.01, "constant offset is removed");

        let mut hp = HighPass::default();
        let mut voice: Vec<f32> = (0..RATE_USIZE)
            .map(|i| (2.0 * std::f32::consts::PI * 400.0 * i as f32 / RATE as f32).sin() * 0.5)
            .collect();
        hp.apply(&mut voice);
        let peak = voice[RATE_USIZE / 2..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.45, "400 Hz passes almost untouched (peak {peak})");
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
