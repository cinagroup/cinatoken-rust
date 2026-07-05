//! Lightweight audio-duration parsing: the WASM-friendly duration source used
//! by request-token estimation. Go reads duration via `common.GetAudioDuration`
//! with container-specific libraries. In the Worker we avoid full decode and
//! external tools, so this module parses common upload headers/frames directly.
//!
//! Parity target: `docs/source-token-estimation-parity.md`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioFormat {
    Wav,
    Mp3,
    Flac,
    Mp4,
    Ogg,
    Opus,
    Aiff,
    Webm,
    Aac,
}

/// Duration in seconds for an uploaded audio file, using filename/content-type
/// hints first and magic bytes as a fallback.
pub fn audio_duration_seconds(
    data: &[u8],
    filename: Option<&str>,
    content_type: Option<&str>,
) -> Option<f64> {
    audio_format_from_hint(filename, content_type)
        .and_then(|format| duration_for_format(data, format))
        .or_else(|| duration_from_magic(data))
}

/// Duration in seconds of a PCM WAV from its header: `frames = pcmSize /
/// (channels * bits/8)` with integer floor, then `frames / sampleRate`. This
/// matches Go `getWAVDuration`, including the declared data-size path and the
/// zero-size fallback to remaining bytes after the data chunk header.
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

        offset = body + chunk_size + (chunk_size & 1);
    }
    None
}

fn audio_format_from_hint(
    filename: Option<&str>,
    content_type: Option<&str>,
) -> Option<AudioFormat> {
    filename
        .and_then(audio_format_from_filename)
        .or_else(|| content_type.and_then(audio_format_from_content_type))
}

fn audio_format_from_filename(filename: &str) -> Option<AudioFormat> {
    let ext = filename.rsplit_once('.')?.1.to_ascii_lowercase();
    match ext.as_str() {
        "wav" | "wave" => Some(AudioFormat::Wav),
        "mp3" => Some(AudioFormat::Mp3),
        "flac" => Some(AudioFormat::Flac),
        "m4a" | "mp4" => Some(AudioFormat::Mp4),
        "ogg" | "oga" => Some(AudioFormat::Ogg),
        "opus" => Some(AudioFormat::Opus),
        "aiff" | "aif" | "aifc" => Some(AudioFormat::Aiff),
        "webm" => Some(AudioFormat::Webm),
        "aac" => Some(AudioFormat::Aac),
        _ => None,
    }
}

fn audio_format_from_content_type(content_type: &str) -> Option<AudioFormat> {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match media_type.as_str() {
        "audio/wav" | "audio/wave" | "audio/x-wav" | "audio/vnd.wave" => Some(AudioFormat::Wav),
        "audio/mpeg" | "audio/mp3" | "audio/x-mpeg" => Some(AudioFormat::Mp3),
        "audio/flac" | "audio/x-flac" => Some(AudioFormat::Flac),
        "audio/mp4" | "video/mp4" | "audio/x-m4a" => Some(AudioFormat::Mp4),
        "audio/ogg" | "application/ogg" => Some(AudioFormat::Ogg),
        "audio/opus" => Some(AudioFormat::Opus),
        "audio/aiff" | "audio/x-aiff" => Some(AudioFormat::Aiff),
        "audio/webm" | "video/webm" => Some(AudioFormat::Webm),
        "audio/aac" | "audio/aacp" => Some(AudioFormat::Aac),
        _ => None,
    }
}

fn duration_for_format(data: &[u8], format: AudioFormat) -> Option<f64> {
    match format {
        AudioFormat::Wav => wav_duration_seconds(data),
        AudioFormat::Mp3 => mp3_duration_seconds(data),
        AudioFormat::Flac => flac_duration_seconds(data),
        AudioFormat::Mp4 => mp4_duration_seconds(data),
        AudioFormat::Ogg => ogg_duration_seconds(data, false),
        AudioFormat::Opus => ogg_duration_seconds(data, true),
        AudioFormat::Aiff => aiff_duration_seconds(data),
        AudioFormat::Webm => webm_duration_seconds(data),
        AudioFormat::Aac => aac_adts_duration_seconds(data),
    }
}

fn duration_from_magic(data: &[u8]) -> Option<f64> {
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        return wav_duration_seconds(data);
    }
    if data.starts_with(b"fLaC") {
        return flac_duration_seconds(data);
    }
    if data.starts_with(b"OggS") {
        return ogg_duration_seconds(data, false);
    }
    if looks_like_ebml(data) {
        return webm_duration_seconds(data);
    }
    if looks_like_mp4(data) {
        return mp4_duration_seconds(data);
    }
    if data.len() >= 12
        && &data[0..4] == b"FORM"
        && (&data[8..12] == b"AIFF" || &data[8..12] == b"AIFC")
    {
        return aiff_duration_seconds(data);
    }
    mp3_duration_seconds(data).or_else(|| aac_adts_duration_seconds(data))
}

fn flac_duration_seconds(data: &[u8]) -> Option<f64> {
    if !data.starts_with(b"fLaC") {
        return None;
    }
    let mut offset = 4;
    while offset + 4 <= data.len() {
        let header = data[offset];
        let is_last = header & 0x80 != 0;
        let block_type = header & 0x7f;
        let len = ((data[offset + 1] as usize) << 16)
            | ((data[offset + 2] as usize) << 8)
            | data[offset + 3] as usize;
        let body = offset + 4;
        if body + len > data.len() {
            return None;
        }
        if block_type == 0 {
            if len < 34 {
                return None;
            }
            let packed = u64_be(&data[body + 10..body + 18]);
            let sample_rate = (packed >> 44) & 0x000f_ffff;
            let total_samples = packed & 0x0000_000f_ffff_ffff;
            return positive_duration(total_samples, sample_rate);
        }
        if is_last {
            break;
        }
        offset = body + len;
    }
    None
}

fn webm_duration_seconds(data: &[u8]) -> Option<f64> {
    if !looks_like_ebml(data) {
        return None;
    }
    let mut offset = 0;
    while let Some(element) = read_ebml_element(data, offset, false) {
        if element.id == 0x1853_8067 {
            return find_webm_info_duration(data, element.data_start, element.data_end);
        }
        offset = element.next;
    }
    None
}

fn looks_like_ebml(data: &[u8]) -> bool {
    data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
}

fn find_webm_info_duration(data: &[u8], start: usize, end: usize) -> Option<f64> {
    let mut offset = start;
    while offset < end {
        let Some(element) = read_ebml_element(data, offset, false) else {
            break;
        };
        if element.id == 0x1549_a966 {
            return parse_webm_info_duration(data, element.data_start, element.data_end);
        }
        offset = element.next;
    }
    None
}

fn parse_webm_info_duration(data: &[u8], start: usize, end: usize) -> Option<f64> {
    let mut offset = start;
    let mut timestamp_scale = 1_000_000u64;
    let mut duration_ticks: Option<f64> = None;

    while offset < end {
        let Some(element) = read_ebml_element(data, offset, false) else {
            break;
        };
        match element.id {
            0x2a_d7_b1 => {
                timestamp_scale = parse_ebml_uint(&data[element.data_start..element.data_end])?;
                if timestamp_scale == 0 {
                    return None;
                }
            }
            0x4489 => {
                duration_ticks = parse_ebml_float(&data[element.data_start..element.data_end])
                    .filter(|v| *v > 0.0);
            }
            _ => {}
        }
        offset = element.next;
    }

    duration_ticks.map(|ticks| ticks * timestamp_scale as f64 / 1_000_000_000.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EbmlElement {
    id: u64,
    data_start: usize,
    data_end: usize,
    next: usize,
}

fn read_ebml_element(data: &[u8], offset: usize, strip_id_marker: bool) -> Option<EbmlElement> {
    let (id, id_len) = read_ebml_vint(data, offset, strip_id_marker)?;
    let size_offset = offset.checked_add(id_len)?;
    let (size, size_len) = read_ebml_vint(data, size_offset, true)?;
    let data_start = size_offset.checked_add(size_len)?;
    let data_end = if is_unknown_ebml_size(size, size_len) {
        data.len()
    } else {
        let size = usize::try_from(size).ok()?;
        data_start.checked_add(size)?
    };
    if data_end > data.len() {
        return None;
    }
    Some(EbmlElement {
        id,
        data_start,
        data_end,
        next: data_end,
    })
}

fn read_ebml_vint(data: &[u8], offset: usize, strip_marker: bool) -> Option<(u64, usize)> {
    let first = *data.get(offset)?;
    if first == 0 {
        return None;
    }
    let len = (first.leading_zeros() as usize) + 1;
    if len > 8 || offset + len > data.len() {
        return None;
    }
    let mut value = if strip_marker {
        (first & (0xff >> len)) as u64
    } else {
        first as u64
    };
    for byte in &data[offset + 1..offset + len] {
        value = (value << 8) | *byte as u64;
    }
    Some((value, len))
}

fn is_unknown_ebml_size(value: u64, len: usize) -> bool {
    len > 0 && len <= 8 && value == ((1u64 << (7 * len)) - 1)
}

fn parse_ebml_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.len() > 8 {
        return None;
    }
    Some(
        bytes
            .iter()
            .fold(0u64, |value, byte| (value << 8) | *byte as u64),
    )
}

fn parse_ebml_float(bytes: &[u8]) -> Option<f64> {
    match bytes.len() {
        4 => Some(f32::from_bits(u32_be(bytes)) as f64),
        8 => Some(f64::from_bits(u64_be(bytes))),
        _ => None,
    }
}

fn mp4_duration_seconds(data: &[u8]) -> Option<f64> {
    find_mp4_mvhd_duration(data, 0, data.len(), 0)
}

fn looks_like_mp4(data: &[u8]) -> bool {
    data.len() >= 12 && (&data[4..8] == b"ftyp" || &data[4..8] == b"moov")
}

fn find_mp4_mvhd_duration(data: &[u8], start: usize, end: usize, depth: u8) -> Option<f64> {
    if depth > 8 || start >= end {
        return None;
    }
    let mut offset = start;
    while offset + 8 <= end && offset + 8 <= data.len() {
        let size32 = u32_be(&data[offset..offset + 4]) as u64;
        let box_type = &data[offset + 4..offset + 8];
        let mut header_size = 8usize;
        let box_size = if size32 == 1 {
            if offset + 16 > end || offset + 16 > data.len() {
                return None;
            }
            header_size = 16;
            u64_be(&data[offset + 8..offset + 16])
        } else if size32 == 0 {
            (end - offset) as u64
        } else {
            size32
        };
        if box_size < header_size as u64 {
            return None;
        }
        let body_start = offset + header_size;
        let body_end = offset.checked_add(box_size as usize)?;
        if body_end > end || body_end > data.len() {
            return None;
        }
        if box_type == b"mvhd" {
            return parse_mp4_mvhd(&data[body_start..body_end]);
        }
        if is_mp4_container(box_type) {
            let child_start = if box_type == b"meta" && body_start + 4 <= body_end {
                body_start + 4
            } else {
                body_start
            };
            if let Some(duration) = find_mp4_mvhd_duration(data, child_start, body_end, depth + 1) {
                return Some(duration);
            }
        }
        offset = body_end;
    }
    None
}

fn is_mp4_container(box_type: &[u8]) -> bool {
    matches!(
        box_type,
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"edts" | b"udta" | b"meta"
    )
}

fn parse_mp4_mvhd(body: &[u8]) -> Option<f64> {
    let version = *body.first()?;
    match version {
        0 => {
            if body.len() < 20 {
                return None;
            }
            let timescale = u32_be(&body[12..16]) as u64;
            let duration = u32_be(&body[16..20]) as u64;
            positive_duration(duration, timescale)
        }
        1 => {
            if body.len() < 32 {
                return None;
            }
            let timescale = u32_be(&body[20..24]) as u64;
            let duration = u64_be(&body[24..32]);
            positive_duration(duration, timescale)
        }
        _ => None,
    }
}

fn ogg_duration_seconds(data: &[u8], force_opus: bool) -> Option<f64> {
    let mut offset = 0;
    let mut sample_rate: Option<u64> = None;
    let mut max_granule = 0u64;
    let mut saw_page = false;

    while offset + 27 <= data.len() {
        if &data[offset..offset + 4] != b"OggS" {
            offset += 1;
            continue;
        }
        saw_page = true;
        let granule = u64_le(&data[offset + 6..offset + 14]);
        if granule != u64::MAX {
            max_granule = max_granule.max(granule);
        }
        let segments = data[offset + 26] as usize;
        let table_start = offset + 27;
        let body_start = table_start + segments;
        if body_start > data.len() {
            return None;
        }
        let body_len: usize = data[table_start..body_start]
            .iter()
            .map(|len| *len as usize)
            .sum();
        let body_end = body_start + body_len;
        if body_end > data.len() {
            return None;
        }
        if sample_rate.is_none() {
            let body = &data[body_start..body_end];
            if body.starts_with(b"OpusHead") {
                sample_rate = Some(48_000);
            } else if body.len() >= 16 && body[0] == 1 && &body[1..7] == b"vorbis" {
                let rate = u32_le(&body[12..16]) as u64;
                if rate > 0 {
                    sample_rate = Some(rate);
                }
            }
        }
        offset = body_end;
    }

    let rate = if force_opus && saw_page {
        48_000
    } else {
        sample_rate?
    };
    positive_duration(max_granule, rate)
}

fn aiff_duration_seconds(data: &[u8]) -> Option<f64> {
    if data.len() < 12
        || &data[0..4] != b"FORM"
        || (&data[8..12] != b"AIFF" && &data[8..12] != b"AIFC")
    {
        return None;
    }
    let mut offset = 12;
    while offset + 8 <= data.len() {
        let chunk_id = &data[offset..offset + 4];
        let chunk_size = u32_be(&data[offset + 4..offset + 8]) as usize;
        let body = offset + 8;
        if body + chunk_size > data.len() {
            return None;
        }
        if chunk_id == b"COMM" {
            if chunk_size < 18 {
                return None;
            }
            let frames = u32_be(&data[body + 2..body + 6]) as u64;
            let sample_rate = extended_float_80(&data[body + 8..body + 18])?;
            if sample_rate <= 0.0 {
                return None;
            }
            return Some(frames as f64 / sample_rate);
        }
        offset = body + chunk_size + (chunk_size & 1);
    }
    None
}

fn extended_float_80(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 10 {
        return None;
    }
    let sign_exp = u16_be(&bytes[0..2]);
    if sign_exp & 0x8000 != 0 {
        return None;
    }
    let exponent = sign_exp & 0x7fff;
    let mantissa = u64_be(&bytes[2..10]);
    if exponent == 0 && mantissa == 0 {
        return Some(0.0);
    }
    Some((mantissa as f64) * 2f64.powi(exponent as i32 - 16_383 - 63))
}

fn aac_adts_duration_seconds(data: &[u8]) -> Option<f64> {
    const SAMPLE_RATES: [u32; 13] = [
        96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025,
        8_000, 7_350,
    ];

    let mut offset = skip_id3v2(data);
    let mut frames = 0u64;
    let mut sample_rate = 0u64;

    while offset + 7 <= data.len() {
        if data[offset] != 0xff || data[offset + 1] & 0xf0 != 0xf0 {
            offset += 1;
            continue;
        }
        let sample_idx = ((data[offset + 2] >> 2) & 0x0f) as usize;
        let Some(rate) = SAMPLE_RATES.get(sample_idx).copied() else {
            offset += 1;
            continue;
        };
        let frame_len = ((data[offset + 3] as usize & 0x03) << 11)
            | ((data[offset + 4] as usize) << 3)
            | ((data[offset + 5] as usize & 0xe0) >> 5);
        let header_len = if data[offset + 1] & 0x01 != 0 { 7 } else { 9 };
        if frame_len < header_len || offset + frame_len > data.len() {
            break;
        }
        if sample_rate == 0 {
            sample_rate = rate as u64;
        }
        frames += 1;
        offset += frame_len;
    }

    positive_duration(frames * 1024, sample_rate)
}

#[derive(Debug, Clone, Copy)]
struct Mp3Frame {
    sample_rate: u32,
    samples_per_frame: u32,
    frame_len: usize,
}

fn mp3_duration_seconds(data: &[u8]) -> Option<f64> {
    let mut offset = skip_id3v2(data);
    let mut duration = 0.0;
    let mut frames = 0u64;

    while offset + 4 <= data.len() {
        let Some(frame) = parse_mp3_frame_header(&data[offset..offset + 4]) else {
            offset += 1;
            continue;
        };
        if offset + frame.frame_len > data.len() {
            break;
        }
        duration += frame.samples_per_frame as f64 / frame.sample_rate as f64;
        frames += 1;
        offset += frame.frame_len;
    }

    if frames > 0 {
        Some(duration)
    } else {
        None
    }
}

fn parse_mp3_frame_header(header: &[u8]) -> Option<Mp3Frame> {
    let raw = u32_be(header);
    if (raw >> 21) & 0x7ff != 0x7ff {
        return None;
    }
    let version_bits = (raw >> 19) & 0x03;
    let layer_bits = (raw >> 17) & 0x03;
    let bitrate_idx = ((raw >> 12) & 0x0f) as usize;
    let sample_idx = ((raw >> 10) & 0x03) as usize;
    let padding = ((raw >> 9) & 0x01) as u32;

    if version_bits == 0x01
        || layer_bits == 0
        || bitrate_idx == 0
        || bitrate_idx == 0x0f
        || sample_idx == 0x03
    {
        return None;
    }

    let sample_rate_base = [44_100u32, 48_000, 32_000][sample_idx];
    let sample_rate = match version_bits {
        0x03 => sample_rate_base,
        0x02 => sample_rate_base / 2,
        0x00 => sample_rate_base / 4,
        _ => return None,
    };

    let bitrate = mp3_bitrate(version_bits, layer_bits, bitrate_idx)? * 1000;
    let samples_per_frame = match layer_bits {
        0x03 => 384,
        0x02 => 1152,
        0x01 if version_bits == 0x03 => 1152,
        0x01 => 576,
        _ => return None,
    };

    let frame_len = match layer_bits {
        0x03 => (((12 * bitrate) / sample_rate) + padding) * 4,
        0x01 if version_bits != 0x03 => ((72 * bitrate) / sample_rate) + padding,
        _ => ((144 * bitrate) / sample_rate) + padding,
    } as usize;

    if frame_len < 4 || sample_rate == 0 {
        return None;
    }
    Some(Mp3Frame {
        sample_rate,
        samples_per_frame,
        frame_len,
    })
}

fn mp3_bitrate(version_bits: u32, layer_bits: u32, idx: usize) -> Option<u32> {
    const V1_L1: [u32; 16] = [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
    ];
    const V1_L2: [u32; 16] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
    ];
    const V1_L3: [u32; 16] = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ];
    const V2_L1: [u32; 16] = [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
    ];
    const V2_L2_L3: [u32; 16] = [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
    ];

    let table = match (version_bits == 0x03, layer_bits) {
        (true, 0x03) => V1_L1,
        (true, 0x02) => V1_L2,
        (true, 0x01) => V1_L3,
        (false, 0x03) => V2_L1,
        (false, 0x02 | 0x01) => V2_L2_L3,
        _ => return None,
    };
    table.get(idx).copied().filter(|rate| *rate > 0)
}

fn skip_id3v2(data: &[u8]) -> usize {
    if data.len() < 10 || &data[0..3] != b"ID3" {
        return 0;
    }
    let size = ((data[6] as usize & 0x7f) << 21)
        | ((data[7] as usize & 0x7f) << 14)
        | ((data[8] as usize & 0x7f) << 7)
        | (data[9] as usize & 0x7f);
    10usize.saturating_add(size).min(data.len())
}

fn positive_duration(samples_or_units: u64, sample_rate_or_timescale: u64) -> Option<f64> {
    if samples_or_units == 0 || sample_rate_or_timescale == 0 {
        return None;
    }
    Some(samples_or_units as f64 / sample_rate_or_timescale as f64)
}

fn u16_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8)
}

fn u16_be(b: &[u8]) -> u32 {
    ((b[0] as u32) << 8) | b[1] as u32
}

fn u32_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8) | ((b[2] as u32) << 16) | ((b[3] as u32) << 24)
}

fn u32_be(b: &[u8]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | b[3] as u32
}

fn u64_le(b: &[u8]) -> u64 {
    (b[0] as u64)
        | ((b[1] as u64) << 8)
        | ((b[2] as u64) << 16)
        | ((b[3] as u64) << 24)
        | ((b[4] as u64) << 32)
        | ((b[5] as u64) << 40)
        | ((b[6] as u64) << 48)
        | ((b[7] as u64) << 56)
}

fn u64_be(b: &[u8]) -> u64 {
    ((b[0] as u64) << 56)
        | ((b[1] as u64) << 48)
        | ((b[2] as u64) << 40)
        | ((b[3] as u64) << 32)
        | ((b[4] as u64) << 24)
        | ((b[5] as u64) << 16)
        | ((b[6] as u64) << 8)
        | b[7] as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(channels: u16, sample_rate: u32, bits: u16, data_size: u32, body: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0, 0, 0, 0]);
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
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

    fn flac(sample_rate: u32, total_samples: u64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.extend_from_slice(&[0x80, 0, 0, 34]);
        let mut streaminfo = [0u8; 34];
        let packed = ((sample_rate as u64) << 44)
            | (1u64 << 41)
            | (15u64 << 36)
            | (total_samples & 0x0000_000f_ffff_ffff);
        streaminfo[10..18].copy_from_slice(&packed.to_be_bytes());
        v.extend_from_slice(&streaminfo);
        v
    }

    fn mp4_mvhd(timescale: u32, duration: u32) -> Vec<u8> {
        let mut mvhd_body = Vec::new();
        mvhd_body.extend_from_slice(&[0, 0, 0, 0]);
        mvhd_body.extend_from_slice(&0u32.to_be_bytes());
        mvhd_body.extend_from_slice(&0u32.to_be_bytes());
        mvhd_body.extend_from_slice(&timescale.to_be_bytes());
        mvhd_body.extend_from_slice(&duration.to_be_bytes());
        let mut mvhd = Vec::new();
        mvhd.extend_from_slice(&((mvhd_body.len() + 8) as u32).to_be_bytes());
        mvhd.extend_from_slice(b"mvhd");
        mvhd.extend_from_slice(&mvhd_body);

        let mut moov = Vec::new();
        moov.extend_from_slice(&((mvhd.len() + 8) as u32).to_be_bytes());
        moov.extend_from_slice(b"moov");
        moov.extend_from_slice(&mvhd);

        let mut ftyp = Vec::new();
        ftyp.extend_from_slice(&16u32.to_be_bytes());
        ftyp.extend_from_slice(b"ftyp");
        ftyp.extend_from_slice(b"M4A ");
        ftyp.extend_from_slice(&0u32.to_be_bytes());

        [ftyp, moov].concat()
    }

    fn ogg_opus(granule: u64) -> Vec<u8> {
        let body = b"OpusHead\x01\x02\x00\x00\x80\xbb\x00\x00\x00\x00\x00";
        let mut v = ogg_page(0, body);
        v.extend_from_slice(&ogg_page(granule, b""));
        v
    }

    fn ogg_vorbis(sample_rate: u32, granule: u64) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"\x01vorbis");
        body.extend_from_slice(&0u32.to_le_bytes());
        body.push(2);
        body.extend_from_slice(&sample_rate.to_le_bytes());
        body.extend_from_slice(&[0; 12]);
        let mut v = ogg_page(0, &body);
        v.extend_from_slice(&ogg_page(granule, b""));
        v
    }

    fn ogg_page(granule: u64, body: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"OggS");
        v.push(0);
        v.push(0);
        v.extend_from_slice(&granule.to_le_bytes());
        v.extend_from_slice(&1u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.push(1);
        v.push(body.len() as u8);
        v.extend_from_slice(body);
        v
    }

    fn aac_adts_frames(sample_idx: u8, frames: usize) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..frames {
            let frame_len = 7usize;
            let profile = 1u8;
            let channels = 2u8;
            v.push(0xff);
            v.push(0xf1);
            v.push((profile << 6) | (sample_idx << 2) | ((channels >> 2) & 0x01));
            v.push(((channels & 0x03) << 6) | ((frame_len >> 11) as u8 & 0x03));
            v.push((frame_len >> 3) as u8);
            v.push(((frame_len & 0x07) as u8) << 5 | 0x1f);
            v.push(0xfc);
        }
        v
    }

    fn mp3_frames(frames: usize) -> Vec<u8> {
        let mut header = 0u32;
        header |= 0x7ff << 21;
        header |= 0x03 << 19;
        header |= 0x01 << 17;
        header |= 0x01 << 16;
        header |= 0x09 << 12;
        let frame_len = 144 * 128_000 / 44_100;
        let mut v = Vec::new();
        for _ in 0..frames {
            v.extend_from_slice(&header.to_be_bytes());
            v.extend(std::iter::repeat(0).take(frame_len as usize - 4));
        }
        v
    }

    fn aiff(sample_rate_80: [u8; 10], frames: u32) -> Vec<u8> {
        let mut comm = Vec::new();
        comm.extend_from_slice(&2u16.to_be_bytes());
        comm.extend_from_slice(&frames.to_be_bytes());
        comm.extend_from_slice(&16u16.to_be_bytes());
        comm.extend_from_slice(&sample_rate_80);

        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"COMM");
        chunk.extend_from_slice(&(comm.len() as u32).to_be_bytes());
        chunk.extend_from_slice(&comm);

        let mut v = Vec::new();
        v.extend_from_slice(b"FORM");
        v.extend_from_slice(&((4 + chunk.len()) as u32).to_be_bytes());
        v.extend_from_slice(b"AIFF");
        v.extend_from_slice(&chunk);
        v
    }

    fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(id);
        v.extend_from_slice(&ebml_size(payload.len()));
        v.extend_from_slice(payload);
        v
    }

    fn ebml_size(size: usize) -> Vec<u8> {
        if size < 0x7f {
            return vec![0x80 | size as u8];
        }
        if size < 0x3fff {
            return vec![0x40 | ((size >> 8) as u8), size as u8];
        }
        vec![0x20 | ((size >> 16) as u8), (size >> 8) as u8, size as u8]
    }

    fn webm(
        duration_ticks: f64,
        timestamp_scale: Option<u64>,
        unknown_segment_size: bool,
    ) -> Vec<u8> {
        let mut info_payload = Vec::new();
        if let Some(scale) = timestamp_scale {
            let scale_bytes = scale.to_be_bytes();
            let first_non_zero = scale_bytes
                .iter()
                .position(|byte| *byte != 0)
                .unwrap_or(scale_bytes.len() - 1);
            info_payload.extend_from_slice(&ebml_element(
                &[0x2a, 0xd7, 0xb1],
                &scale_bytes[first_non_zero..],
            ));
        }
        info_payload.extend_from_slice(&ebml_element(
            &[0x44, 0x89],
            &duration_ticks.to_bits().to_be_bytes(),
        ));
        let info = ebml_element(&[0x15, 0x49, 0xa9, 0x66], &info_payload);
        let ebml_header = ebml_element(&[0x1a, 0x45, 0xdf, 0xa3], &[]);

        let mut v = ebml_header;
        v.extend_from_slice(&[0x18, 0x53, 0x80, 0x67]);
        if unknown_segment_size {
            v.push(0xff);
            v.extend_from_slice(&info);
        } else {
            v.extend_from_slice(&ebml_size(info.len()));
            v.extend_from_slice(&info);
        }
        v
    }

    #[test]
    fn computes_duration_from_declared_data_size() {
        let w = wav(1, 8000, 16, 32000, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(2.0));
        let w = wav(2, 44100, 16, 176400, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(1.0));
    }

    #[test]
    fn floors_partial_frames_like_go() {
        let w = wav(1, 8000, 16, 32001, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(2.0));
    }

    #[test]
    fn zero_data_size_falls_back_to_remaining_bytes() {
        let w = wav(1, 8000, 16, 0, &vec![0u8; 4000]);
        assert_eq!(wav_duration_seconds(&w), Some(0.25));
    }

    #[test]
    fn rejects_non_wav_and_bad_metadata() {
        assert_eq!(wav_duration_seconds(b""), None);
        assert_eq!(wav_duration_seconds(b"not a wav file at all"), None);
        let w = wav(1, 0, 16, 32000, &[]);
        assert_eq!(wav_duration_seconds(&w), None);
    }

    #[test]
    fn parses_from_header_prefix_without_data_body() {
        let w = wav(1, 16000, 16, 320000, &[]);
        assert_eq!(wav_duration_seconds(&w), Some(10.0));
    }

    #[test]
    fn flac_streaminfo_duration() {
        let data = flac(48_000, 144_000);
        assert_eq!(
            audio_duration_seconds(&data, Some("clip.flac"), Some("audio/flac")),
            Some(3.0)
        );
    }

    #[test]
    fn mp4_mvhd_duration() {
        let data = mp4_mvhd(1_000, 12_345);
        assert_eq!(
            audio_duration_seconds(&data, Some("voice.m4a"), Some("audio/mp4")),
            Some(12.345)
        );
    }

    #[test]
    fn ogg_opus_and_vorbis_duration() {
        let opus = ogg_opus(96_000);
        assert_eq!(
            audio_duration_seconds(&opus, Some("voice.opus"), Some("audio/opus")),
            Some(2.0)
        );

        let vorbis = ogg_vorbis(44_100, 88_200);
        assert_eq!(
            audio_duration_seconds(&vorbis, Some("voice.ogg"), Some("audio/ogg")),
            Some(2.0)
        );
    }

    #[test]
    fn aac_adts_duration() {
        let data = aac_adts_frames(4, 3);
        let duration = audio_duration_seconds(&data, Some("voice.aac"), Some("audio/aac")).unwrap();
        assert!((duration - (3072.0 / 44_100.0)).abs() < 0.000001);
    }

    #[test]
    fn mp3_frame_duration_skips_id3() {
        let mut data = b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();
        data.extend_from_slice(&mp3_frames(2));
        let duration =
            audio_duration_seconds(&data, Some("voice.mp3"), Some("audio/mpeg")).unwrap();
        assert!((duration - (2304.0 / 44_100.0)).abs() < 0.000001);
    }

    #[test]
    fn aiff_comm_duration() {
        let data = aiff([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0], 44_100);
        assert_eq!(
            audio_duration_seconds(&data, Some("voice.aiff"), Some("audio/aiff")),
            Some(1.0)
        );
    }

    #[test]
    fn webm_duration_uses_default_timestamp_scale() {
        let data = webm(1234.0, None, false);
        let duration =
            audio_duration_seconds(&data, Some("voice.webm"), Some("audio/webm")).unwrap();
        assert!((duration - 1.234).abs() < 0.000001);
    }

    #[test]
    fn webm_duration_uses_explicit_timestamp_scale() {
        let data = webm(2500.0, Some(2_000_000), false);
        let duration =
            audio_duration_seconds(&data, Some("voice.webm"), Some("audio/webm")).unwrap();
        assert!((duration - 5.0).abs() < 0.000001);
    }

    #[test]
    fn webm_duration_allows_unknown_segment_size() {
        let data = webm(42.0, Some(1_000_000), true);
        let duration =
            audio_duration_seconds(&data, Some("voice.webm"), Some("audio/webm")).unwrap();
        assert!((duration - 0.042).abs() < 0.000001);
    }
}
