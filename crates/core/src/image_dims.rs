//! Lightweight image-header dimension parser — the WASM-friendly substitute for
//! Go's full `image.DecodeConfig` / `webp.DecodeConfig` used by
//! `service.GetImageConfig` (`service/file_service.go:387`). Go decodes the image
//! config to read width/height before calling `getImageToken`; this module reads
//! the same width/height directly from the container header without decoding
//! pixels, which is all `image_tokens` needs. Parity target:
//! `docs/source-token-estimation-parity.md` (checklist #4, "image-dimension
//! source").
//!
//! Supported formats: PNG, JPEG, GIF, WebP (the set named in the parity doc).
//! HEIF/HEIC (which Go also handles via a custom ISOBMFF `ispe` parser) is not
//! parsed here; callers treat an undecodable image as a flat fallback.

/// Parse the pixel dimensions `(width, height)` from an image container header.
/// Returns `None` if the bytes are not a recognized/parseable PNG, JPEG, GIF, or
/// WebP header. Only the leading header bytes are inspected, so a truncated
/// prefix of the file is sufficient.
pub fn image_dimensions(data: &[u8]) -> Option<(i64, i64)> {
    png_dimensions(data)
        .or_else(|| jpeg_dimensions(data))
        .or_else(|| gif_dimensions(data))
        .or_else(|| webp_dimensions(data))
}

fn u16_be(b: &[u8]) -> u32 {
    ((b[0] as u32) << 8) | (b[1] as u32)
}

fn u16_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8)
}

fn u24_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8) | ((b[2] as u32) << 16)
}

fn u32_be(b: &[u8]) -> u32 {
    ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
}

fn u32_le(b: &[u8]) -> u32 {
    (b[0] as u32) | ((b[1] as u32) << 8) | ((b[2] as u32) << 16) | ((b[3] as u32) << 24)
}

/// PNG: 8-byte signature, then the IHDR chunk (`len` + `"IHDR"` + 4-byte BE
/// width + 4-byte BE height). IHDR is always the first chunk.
fn png_dimensions(d: &[u8]) -> Option<(i64, i64)> {
    const SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if d.len() < 24 || d[0..8] != SIG || &d[12..16] != b"IHDR" {
        return None;
    }
    let w = u32_be(&d[16..20]) as i64;
    let h = u32_be(&d[20..24]) as i64;
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// GIF: `"GIF87a"`/`"GIF89a"` magic, then the logical-screen width/height as
/// 16-bit little-endian values.
fn gif_dimensions(d: &[u8]) -> Option<(i64, i64)> {
    if d.len() < 10 || (&d[0..6] != b"GIF87a" && &d[0..6] != b"GIF89a") {
        return None;
    }
    let w = u16_le(&d[6..8]) as i64;
    let h = u16_le(&d[8..10]) as i64;
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// JPEG: SOI (`FF D8`), then walk marker segments until a Start-Of-Frame marker,
/// whose payload carries `[precision][height BE][width BE]`.
fn jpeg_dimensions(d: &[u8]) -> Option<(i64, i64)> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 1 < d.len() {
        if d[i] != 0xFF {
            return None;
        }
        // Advance past the 0xFF (and any 0xFF fill bytes) to the marker byte.
        i += 1;
        while i < d.len() && d[i] == 0xFF {
            i += 1;
        }
        if i >= d.len() {
            return None;
        }
        let marker = d[i];
        // Standalone markers (TEM, RSTn, SOI, EOI) carry no length payload.
        if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            i += 1;
            continue;
        }
        // All other markers are followed by a 2-byte (BE) segment length that
        // includes the length bytes themselves.
        if i + 2 >= d.len() {
            return None;
        }
        let seg_len = u16_be(&d[i + 1..i + 3]) as usize;
        if seg_len < 2 {
            return None;
        }
        if is_sof_marker(marker) {
            // Payload: precision(1) at i+3, height(2) at i+4, width(2) at i+6.
            if i + 8 > d.len() {
                return None;
            }
            let h = u16_be(&d[i + 4..i + 6]) as i64;
            let w = u16_be(&d[i + 6..i + 8]) as i64;
            if w == 0 || h == 0 {
                return None;
            }
            return Some((w, h));
        }
        i = i + 1 + seg_len;
    }
    None
}

/// SOF markers carry frame dimensions. `0xC4` (DHT), `0xC8` (JPG), and `0xCC`
/// (DAC) sit in the same numeric range but are not frame headers.
fn is_sof_marker(m: u8) -> bool {
    matches!(
        m,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

/// WebP: `RIFF....WEBP` then a `VP8 ` (lossy), `VP8L` (lossless), or `VP8X`
/// (extended) chunk, each encoding the canvas dimensions differently.
fn webp_dimensions(d: &[u8]) -> Option<(i64, i64)> {
    if d.len() < 16 || &d[0..4] != b"RIFF" || &d[8..12] != b"WEBP" {
        return None;
    }
    match &d[12..16] {
        b"VP8 " => {
            // Lossy: bitstream at offset 20; key-frame start code 9D 01 2A at
            // [23..26], then 14-bit width/height (LE).
            if d.len() < 30 || d[23] != 0x9D || d[24] != 0x01 || d[25] != 0x2A {
                return None;
            }
            let w = (u16_le(&d[26..28]) & 0x3FFF) as i64;
            let h = (u16_le(&d[28..30]) & 0x3FFF) as i64;
            non_zero(w, h)
        }
        b"VP8L" => {
            // Lossless: 0x2F signature at offset 20, then packed 14-bit
            // (width-1) and (height-1).
            if d.len() < 25 || d[20] != 0x2F {
                return None;
            }
            let bits = u32_le(&d[21..25]);
            let w = ((bits & 0x3FFF) + 1) as i64;
            let h = (((bits >> 14) & 0x3FFF) + 1) as i64;
            non_zero(w, h)
        }
        b"VP8X" => {
            // Extended: 24-bit (canvas width-1) at [24..27], (height-1) at
            // [27..30].
            if d.len() < 30 {
                return None;
            }
            let w = (u24_le(&d[24..27]) + 1) as i64;
            let h = (u24_le(&d[27..30]) + 1) as i64;
            non_zero(w, h)
        }
        _ => None,
    }
}

fn non_zero(w: i64, h: i64) -> Option<(i64, i64)> {
    if w == 0 || h == 0 {
        None
    } else {
        Some((w, h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_header_dimensions() {
        // 8-byte sig | len=13 | "IHDR" | width=512 | height=256 | (rest ignored)
        let mut d = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        d.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D]); // IHDR length
        d.extend_from_slice(b"IHDR");
        d.extend_from_slice(&[0x00, 0x00, 0x02, 0x00]); // 512
        d.extend_from_slice(&[0x00, 0x00, 0x01, 0x00]); // 256
        d.extend_from_slice(&[8, 6, 0, 0, 0]); // bit depth/color/etc.
        assert_eq!(image_dimensions(&d), Some((512, 256)));
    }

    #[test]
    fn gif_header_dimensions() {
        let mut d = b"GIF89a".to_vec();
        d.extend_from_slice(&[0x00, 0x02]); // 512 LE
        d.extend_from_slice(&[0x00, 0x01]); // 256 LE
        d.extend_from_slice(&[0xF7, 0x00, 0x00]);
        assert_eq!(image_dimensions(&d), Some((512, 256)));
        let mut old = b"GIF87a".to_vec();
        old.extend_from_slice(&[0x40, 0x00, 0x20, 0x00]); // 64 x 32
        assert_eq!(image_dimensions(&old), Some((64, 32)));
    }

    #[test]
    fn jpeg_header_dimensions() {
        // SOI | APP0 (len 16, 14 payload) | SOF0 (len 17, height=256 width=512)
        let mut d = vec![0xFF, 0xD8];
        d.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]); // APP0, len 16
        d.extend_from_slice(b"JFIF\0");
        d.extend_from_slice(&[0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]); // 9 bytes
        d.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11]); // SOF0, len 17
        d.push(0x08); // precision
        d.extend_from_slice(&[0x01, 0x00]); // height 256
        d.extend_from_slice(&[0x02, 0x00]); // width 512
        d.push(0x03); // components
        assert_eq!(image_dimensions(&d), Some((512, 256)));
    }

    #[test]
    fn jpeg_skips_app_segment_before_sof() {
        // Ensure the marker walk skips a length-bearing APPn segment correctly.
        let mut d = vec![0xFF, 0xD8];
        d.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x06, 0xAA, 0xBB, 0xCC, 0xDD]); // APP1 len 6
        d.extend_from_slice(&[0xFF, 0xC2, 0x00, 0x11]); // progressive SOF2
        d.push(0x08);
        d.extend_from_slice(&[0x00, 0xC8]); // height 200
        d.extend_from_slice(&[0x01, 0x2C]); // width 300
        assert_eq!(image_dimensions(&d), Some((300, 200)));
    }

    #[test]
    fn webp_vp8x_dimensions() {
        let mut d = b"RIFF".to_vec();
        d.extend_from_slice(&[0x1A, 0x00, 0x00, 0x00]); // file size (ignored)
        d.extend_from_slice(b"WEBP");
        d.extend_from_slice(b"VP8X");
        d.extend_from_slice(&[0x0A, 0x00, 0x00, 0x00]); // chunk size
        d.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // flags + reserved
        d.extend_from_slice(&[0xFF, 0x01, 0x00]); // width-1 = 511 -> 512
        d.extend_from_slice(&[0xFF, 0x00, 0x00]); // height-1 = 255 -> 256
        assert_eq!(image_dimensions(&d), Some((512, 256)));
    }

    #[test]
    fn webp_vp8l_dimensions() {
        // width=512 (511), height=256 (255): bits = (255<<14)|511 = 0x003FC1FF.
        let mut d = b"RIFF".to_vec();
        d.extend_from_slice(&[0x14, 0x00, 0x00, 0x00]);
        d.extend_from_slice(b"WEBP");
        d.extend_from_slice(b"VP8L");
        d.extend_from_slice(&[0x08, 0x00, 0x00, 0x00]); // chunk size
        d.push(0x2F); // signature
        d.extend_from_slice(&[0xFF, 0xC1, 0x3F, 0x00]); // 0x003FC1FF LE
        assert_eq!(image_dimensions(&d), Some((512, 256)));
    }

    #[test]
    fn webp_vp8_lossy_dimensions() {
        let mut d = b"RIFF".to_vec();
        d.extend_from_slice(&[0x1A, 0x00, 0x00, 0x00]);
        d.extend_from_slice(b"WEBP");
        d.extend_from_slice(b"VP8 ");
        d.extend_from_slice(&[0x0E, 0x00, 0x00, 0x00]); // chunk size
        d.extend_from_slice(&[0x30, 0x01, 0x00]); // frame tag (3 bytes)
        d.extend_from_slice(&[0x9D, 0x01, 0x2A]); // start code
        d.extend_from_slice(&[0x00, 0x02]); // width 512 (14-bit LE)
        d.extend_from_slice(&[0x00, 0x01]); // height 256
        assert_eq!(image_dimensions(&d), Some((512, 256)));
    }

    #[test]
    fn rejects_unknown_and_truncated() {
        assert_eq!(image_dimensions(b""), None);
        assert_eq!(image_dimensions(b"not an image at all"), None);
        assert_eq!(image_dimensions(&[0u8; 64]), None);
        // PNG signature but truncated before dimensions.
        assert_eq!(
            image_dimensions(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            None
        );
    }
}
