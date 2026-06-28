//! Lightweight audio-duration parsing — the WASM-friendly "duration source" the
//! token-estimation parity doc (#5) calls for, feeding
//! [`crate::request_tokens::audio_transcription_tokens`] /
//! `realtime_audio_*_tokens`. Go reads duration via `common.GetAudioDuration`
//! (`common/audio.go`), which decodes the container with format-specific
//! libraries. Decoding every container in WASM is heavy, so this module parses
//! the **WAV** header directly (exact for PCM WAV — the format with a trivially
//! computable duration); other containers (MP3/FLAC/M4A/OGG/Opus) are a
//! documented follow-up (header parse / size estimate / Container, §21.4).
//!
//! Parity target: `docs/source-token-estimation-parity.md`.

/// Duration in seconds of a PCM WAV from its header — a faithful port of Go
/// `getWAVDuration`: `frames = pcmSize / (channels * bits/8)` (integer floor),
/// `duration = frames / sampleRate`. `pcmSize` is the declared `data` chunk size
/// (matching Go's `dec.PCMSize`); when that is 0 (streaming WAV) it falls back to
/// the bytes after the `data` chunk header, like Go's `fileSize - pos` path.
/// Returns `None` for non-WAV input or invalid/zero `fmt` metadata. Only the
/// `fmt ` and `data` chunk **headers** are needed, so a truncated prefix works.
pub fn wav_duration_seconds(data: &[u8]) -> Option<f64> {
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return None;
    }

    let mut offset = 12;
    let mut channels: Option<u32> = None;
    let mut sample_rate: Option<u32> = None;
    let mut bits_per_sample: Option<u32> = None;
    let mut pcm_size: Option<u64> = None;

    while offset + 8 <= data.len() {
        let chunk_id = &data[offset..offset + 4];
        let chunk_size = u32_le(&data[offset + 4..offset + 8]) as usize;
        let body = offset + 8;

        if chunk_id == b"fmt " && body + 16 <= data.len() {
            channels = Some(u16_le(&data[body + 2..body + 4]));
            sample_rate = Some(u32_le(&data[body + 4..body + 8]));
            bits_per_sample = Some(u16_le(&data[body + 14..body + 16]));
        } else if chunk_id == b"data" {
            pcm_size = Some(if chunk_size > 0 {
                chunk_size as u64
            } else {
                // Streaming/unknown size: the remaining bytes are the PCM data.
                (data.len() - body) as u64
            });
        }

        if let (Some(channels), Some(sample_rate), Some(bits), Some(pcm_size)) =
            (channels, sample_rate, bits_per_sample, pcm_size)
        {
            let bytes_per_frame = channels as u64 * (bits as u64 / 8);
            if bytes_per_frame == 0 || sample_rate == 0 {
                return None;
            }
            let total_frames = pcm_size / bytes_per_frame;
            return Some(total_frames as f64 / sample_rate as f64);
        }

        // Advance past this chunk (chunks are padded to an even length).
        offset = body + chunk_size + (chunk_size & 1);
    }
    None
}

fn u16_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8)
}

fn u32_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8) | ((b[2] as u32) << 16) | ((b[3] as u32) << 24)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal PCM WAV header with the given parameters and a `data`
    /// chunk declaring `data_size` (body optional).
    fn wav(channels: u16, sample_rate: u32, bits: u16, data_size: u32, body: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0, 0, 0, 0]); // RIFF size (ignored)
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
        v.extend_from_slice(&byte_rate.to_le_bytes());
        let block_align = channels * (bits / 8);
        v.extend_from_slice(&block_align.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_size.to_le_bytes());
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn computes_duration_from_declared_data_size() {
        // mono, 8 kHz, 16-bit, 32000 bytes -> 16000 frames -> 2.0 s.
        let w = wav(1, 8000, 16, 32000, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(2.0));
        // stereo, 44.1 kHz, 16-bit, 176400 bytes -> 44100 frames -> 1.0 s.
        let w = wav(2, 44100, 16, 176400, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(1.0));
    }

    #[test]
    fn floors_partial_frames_like_go() {
        // 32001 bytes / 2 bytes-per-frame = 16000 frames (floor) -> 2.0 s, not 2.0000625.
        let w = wav(1, 8000, 16, 32001, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(2.0));
    }

    #[test]
    fn zero_data_size_falls_back_to_remaining_bytes() {
        // Declared 0 -> use the 4000-byte body: 2000 frames / 8000 = 0.25 s.
        let w = wav(1, 8000, 16, 0, &vec![0u8; 4000]);
        assert_eq!(wav_duration_seconds(&w), Some(0.25));
    }

    #[test]
    fn rejects_non_wav_and_bad_metadata() {
        assert_eq!(wav_duration_seconds(b""), None);
        assert_eq!(wav_duration_seconds(b"not a wav file at all"), None);
        // fmt with a zero sample rate -> None (invalid metadata).
        let w = wav(1, 0, 16, 32000, &[]);
        assert_eq!(wav_duration_seconds(&w), None);
    }

    #[test]
    fn parses_from_header_prefix_without_data_body() {
        // Full file would be large; only the fmt + data chunk headers are needed.
        let w = wav(1, 16000, 16, 320000, &[]); // declares 10 s, no body bytes
        assert_eq!(wav_duration_seconds(&w), Some(10.0));
    }
}
