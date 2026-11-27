//! macOS native system audio capture (CoreAudio Process Tap, macOS 14.2+) and mic activity detection.
//!
//! Uses `CATapDescription` + `AudioHardwareCreateProcessTap` wrapped in a private CoreAudio
//! aggregate device so Atelier can capture meeting participants' audio without virtual audio
//! cables (like BlackHole) and without requiring full Screen Recording permission.

use std::ffi::c_void;
use std::ptr::NonNull;

use objc2::AnyThread;
use objc2_core_audio::{
    kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioHardwarePropertyDefaultInputDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData,
    AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString};
use objc2_foundation::{NSArray, NSNumber, NSString};

use crate::meeting_audio::{Buffer, Resampler, RATE};

/// FourCC for `kAudioTapPropertyFormat` ('tfmt').
const K_AUDIO_TAP_PROPERTY_FORMAT: u32 = 0x7466_6d74;

struct TapState {
    buf: Buffer,
    resampler: Resampler,
    channels: usize,
}

pub struct SystemAudioTap {
    tap_id: AudioObjectID,
    agg_device_id: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
    state_ptr: *mut TapState,
}

// Safety: `SystemAudioTap` only holds CoreAudio integer IDs and a heap-allocated `TapState`
// that is exclusively accessed by the CoreAudio IOProc callback until `Drop` stops and destroys it.
unsafe impl Send for SystemAudioTap {}

impl Drop for SystemAudioTap {
    fn drop(&mut self) {
        unsafe {
            let _ = AudioDeviceStop(self.agg_device_id, self.io_proc_id);
            let _ = AudioDeviceDestroyIOProcID(self.agg_device_id, self.io_proc_id);
            let _ = AudioHardwareDestroyAggregateDevice(self.agg_device_id);
            let _ = AudioHardwareDestroyProcessTap(self.tap_id);
            if !self.state_ptr.is_null() {
                drop(Box::from_raw(self.state_ptr));
                self.state_ptr = std::ptr::null_mut();
            }
        }
    }
}

unsafe extern "C-unwind" fn tap_io_proc(
    _in_device: AudioObjectID,
    _in_now: NonNull<AudioTimeStamp>,
    in_input_data: NonNull<AudioBufferList>,
    _in_input_time: NonNull<AudioTimeStamp>,
    _out_output_data: NonNull<AudioBufferList>,
    _in_output_time: NonNull<AudioTimeStamp>,
    in_client_data: *mut c_void,
) -> i32 {
    if in_client_data.is_null() {
        return 0;
    }
    let state = &mut *(in_client_data as *mut TapState);
    let abl = in_input_data.as_ref();
    let num_buffers = abl.mNumberBuffers as usize;
    if num_buffers == 0 {
        return 0;
    }
    let buffers = std::slice::from_raw_parts(abl.mBuffers.as_ptr(), num_buffers);
    let mut local = Vec::new();

    if num_buffers == 1 {
        let b = &buffers[0];
        if !b.mData.is_null() && b.mDataByteSize > 0 {
            let sample_count = b.mDataByteSize as usize / std::mem::size_of::<f32>();
            let samples = std::slice::from_raw_parts(b.mData as *const f32, sample_count);
            let ch = (b.mNumberChannels as usize).max(state.channels).max(1);
            if ch == 1 {
                for &s in samples {
                    state.resampler.push(s, &mut local);
                }
            } else {
                for frame in samples.chunks_exact(ch) {
                    let sum: f32 = frame.iter().copied().sum();
                    state.resampler.push(sum / ch as f32, &mut local);
                }
            }
        }
    } else {
        // Non-interleaved buffers: average across buffers per frame.
        let frame_count = buffers
            .iter()
            .map(|b| if b.mData.is_null() { 0 } else { b.mDataByteSize as usize / std::mem::size_of::<f32>() })
            .min()
            .unwrap_or(0);
        for i in 0..frame_count {
            let mut sum = 0.0f32;
            for b in buffers {
                let slice = std::slice::from_raw_parts(b.mData as *const f32, frame_count);
                sum += slice[i];
            }
            state.resampler.push(sum / num_buffers as f32, &mut local);
        }
    }

    if !local.is_empty() {
        if let Ok(mut guard) = state.buf.lock() {
            guard.extend_from_slice(&local);
        }
    }
    0
}

fn cf_str(s: &str) -> CFRetained<CFString> {
    CFString::from_str(s)
}

fn cf_dict(pairs: &[(&CFString, *const c_void)]) -> CFRetained<CFDictionary> {
    let keys: Vec<*const c_void> = pairs.iter().map(|(k, _)| (*k as *const CFString).cast()).collect();
    let vals: Vec<*const c_void> = pairs.iter().map(|(_, v)| *v).collect();
    unsafe {
        CFDictionary::new(
            None,
            keys.as_ptr().cast_mut(),
            vals.as_ptr().cast_mut(),
            pairs.len() as isize,
            std::ptr::null(),
            std::ptr::null(),
        )
        .expect("CFDictionary::new failed")
    }
}

/// Opens a global macOS CoreAudio Process Tap (macOS 14.2+) and streams 16 kHz mono audio into `buf`.
pub fn open_system_audio(buf: Buffer) -> Result<SystemAudioTap, String> {
    unsafe {
        let exclude: objc2::rc::Retained<NSArray<NSNumber>> = NSArray::new();
        let desc = CATapDescription::initMonoGlobalTapButExcludeProcesses(
            CATapDescription::alloc(),
            &exclude,
        );
        desc.setName(&NSString::from_str("Atelier System Audio"));
        desc.setMuteBehavior(CATapMuteBehavior::Unmuted);
        desc.setPrivate(true);

        let mut tap_id: AudioObjectID = 0;
        let status = AudioHardwareCreateProcessTap(Some(&desc), &mut tap_id);
        if status != 0 || tap_id == 0 {
            return Err(format!(
                "CoreAudio Process Tap gagal (OSStatus {status}). Pastikan macOS 14.2+ dan izin System Audio Recording aktif."
            ));
        }

        // Read the tap's native stream format (sample rate & channels).
        let mut asbd = AudioStreamBasicDescription {
            mSampleRate: 48_000.0,
            mFormatID: 0,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 0,
            mBytesPerFrame: 0,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 0,
            mReserved: 0,
        };
        let mut data_size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
        let addr = AudioObjectPropertyAddress {
            mSelector: K_AUDIO_TAP_PROPERTY_FORMAT,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let _ = AudioObjectGetPropertyData(
            tap_id,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut data_size),
            NonNull::new_unchecked((&mut asbd as *mut AudioStreamBasicDescription).cast()),
        );
        let in_rate = if asbd.mSampleRate >= 8_000.0 && asbd.mSampleRate <= 384_000.0 {
            asbd.mSampleRate.round() as u32
        } else {
            48_000
        };
        let channels = (asbd.mChannelsPerFrame as usize).max(1);

        let tap_uuid = desc.UUID().UUIDString().to_string();
        let agg_uid_str = format!("com.atelier.desktop.tap.{tap_uuid}");

        // Build tap entry dictionary: { "uid": tap_uuid, "drift": true }
        let k_uid = cf_str("uid");
        let k_drift = cf_str("drift");
        let v_tap_uid = cf_str(&tap_uuid);
        let v_true = CFBoolean::new(true);
        let v_false = CFBoolean::new(false);

        let tap_entry = cf_dict(&[
            (&k_uid, (&*v_tap_uid as *const CFString).cast()),
            (&k_drift, (&*v_true as *const CFBoolean).cast()),
        ]);

        let mut tap_entry_ptr: *const c_void = (&*tap_entry as *const CFDictionary).cast();
        let tap_list = CFArray::new(None, &mut tap_entry_ptr, 1, std::ptr::null())
            .ok_or_else(|| "Gagal membuat CFArray untuk tap list".to_string())?;

        // Build aggregate device dictionary.
        let k_name = cf_str("name");
        let k_private = cf_str("private");
        let k_stacked = cf_str("stacked");
        let k_tap_auto = cf_str("tapautostart");
        let k_taps = cf_str("taps");
        let v_agg_name = cf_str("Atelier System Audio Tap");
        let v_agg_uid = cf_str(&agg_uid_str);
        let v_one = CFNumber::new_i32(1);

        let agg_desc = cf_dict(&[
            (&k_uid, (&*v_agg_uid as *const CFString).cast()),
            (&k_name, (&*v_agg_name as *const CFString).cast()),
            (&k_private, (&*v_true as *const CFBoolean).cast()),
            (&k_stacked, (&*v_false as *const CFBoolean).cast()),
            (&k_tap_auto, (&*v_one as *const CFNumber).cast()),
            (&k_taps, (&*tap_list as *const CFArray).cast()),
        ]);

        let mut agg_device_id: AudioObjectID = 0;
        let status = AudioHardwareCreateAggregateDevice(&agg_desc, NonNull::from(&mut agg_device_id));
        if status != 0 || agg_device_id == 0 {
            let _ = AudioHardwareDestroyProcessTap(tap_id);
            return Err(format!("Gagal membuat CoreAudio Aggregate Device (OSStatus {status})."));
        }

        let state = Box::new(TapState {
            buf,
            resampler: Resampler::new(in_rate.max(RATE)),
            channels,
        });
        let state_ptr = Box::into_raw(state);

        let mut io_proc_id: AudioDeviceIOProcID = None;
        let status = AudioDeviceCreateIOProcID(
            agg_device_id,
            Some(tap_io_proc),
            state_ptr.cast(),
            NonNull::from(&mut io_proc_id),
        );
        if status != 0 {
            let _ = AudioHardwareDestroyAggregateDevice(agg_device_id);
            let _ = AudioHardwareDestroyProcessTap(tap_id);
            drop(Box::from_raw(state_ptr));
            return Err(format!("Gagal membuat CoreAudio IOProc (OSStatus {status})."));
        }

        let status = AudioDeviceStart(agg_device_id, io_proc_id);
        if status != 0 {
            let _ = AudioDeviceDestroyIOProcID(agg_device_id, io_proc_id);
            let _ = AudioHardwareDestroyAggregateDevice(agg_device_id);
            let _ = AudioHardwareDestroyProcessTap(tap_id);
            drop(Box::from_raw(state_ptr));
            return Err(format!("Gagal memulai CoreAudio Tap (OSStatus {status})."));
        }

        Ok(SystemAudioTap {
            tap_id,
            agg_device_id,
            io_proc_id,
            state_ptr,
        })
    }
}

/// Returns `true` if the default macOS microphone is currently being used by any application.
pub fn is_default_mic_running() -> bool {
    unsafe {
        let mut device_id: AudioObjectID = 0;
        let mut size = std::mem::size_of::<AudioObjectID>() as u32;
        let default_addr = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&default_addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::new_unchecked((&mut device_id as *mut AudioObjectID).cast()),
        );
        if status != 0 || device_id == 0 {
            return false;
        }

        let mut running: u32 = 0;
        let mut run_size = std::mem::size_of::<u32>() as u32;
        let run_addr = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let status = AudioObjectGetPropertyData(
            device_id,
            NonNull::from(&run_addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut run_size),
            NonNull::new_unchecked((&mut running as *mut u32).cast()),
        );
        status == 0 && running != 0
    }
}
