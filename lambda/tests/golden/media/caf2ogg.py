"""Rewrap a mono Opus CAF (from macOS afconvert) as Ogg/Opus, the format of a
Telegram voice note. afconvert encodes Opus but cannot write Ogg on current
macOS, and this avoids installing ffmpeg. Stdlib only; RFC 7845 framing.

Usage: python3 caf2ogg.py note.caf note.ogg
"""
import struct
import sys

SERIAL = 0x46494E46  # fixed so the output is byte-for-byte reproducible

CRC_TABLE = []
for i in range(256):
    r = i << 24
    for _ in range(8):
        r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
    CRC_TABLE.append(r & 0xFFFFFFFF)


def crc(data):
    c = 0
    for b in data:
        c = ((c << 8) & 0xFFFFFFFF) ^ CRC_TABLE[((c >> 24) ^ b) & 0xFF]
    return c


def read_caf(path):
    raw = open(path, "rb").read()
    assert raw[:4] == b"caff", "not a CAF file"
    chunks, pos = {}, 8
    while pos < len(raw):
        kind, size = raw[pos:pos + 4], struct.unpack(">q", raw[pos + 4:pos + 12])[0]
        chunks[kind] = raw[pos + 12:pos + 12 + size]
        pos += 12 + size
    desc = chunks[b"desc"]
    assert desc[8:12] == b"opus" and struct.unpack(">I", desc[24:28])[0] == 1, "need mono Opus"
    frames_per_packet = struct.unpack(">I", desc[20:24])[0]
    pakt = chunks[b"pakt"]
    count, valid, priming, _ = struct.unpack(">qqii", pakt[:24])
    sizes, n, value = [], 24, 0
    while len(sizes) < count:
        b = pakt[n]
        n += 1
        value = (value << 7) | (b & 0x7F)
        if not b & 0x80:
            sizes.append(value)
            value = 0
    data, packets, off = chunks[b"data"][4:], [], 0
    for s in sizes:
        packets.append(data[off:off + s])
        off += s
    return packets, frames_per_packet, valid, priming


def page(packets, granule, seq, flags):
    lacing = b""
    for p in packets:
        lacing += b"\xff" * (len(p) // 255) + bytes([len(p) % 255])
    assert len(lacing) <= 255
    header = b"OggS" + struct.pack("<BBqIIIB", 0, flags, granule, SERIAL, seq, 0, len(lacing))
    body = header + lacing + b"".join(packets)
    return body[:22] + struct.pack("<I", crc(body)) + body[26:]


def main(src, dst):
    packets, fpp, valid, priming = read_caf(src)
    head = b"OpusHead" + struct.pack("<BBHIhB", 1, 1, priming, 48000, 0, 0)
    vendor = b"finflow caf2ogg"
    tags = b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0)
    out = [page([head], 0, 0, 0x02), page([tags], 0, 1, 0)]
    per_page, end = 50, priming + valid
    for i in range(0, len(packets), per_page):
        chunk = packets[i:i + per_page]
        last = i + per_page >= len(packets)
        # Granule counts decoded samples, pre-skip included (RFC 7845 4).
        granule = end if last else (i + len(chunk)) * fpp
        out.append(page(chunk, granule, len(out), 0x04 if last else 0))
    open(dst, "wb").write(b"".join(out))


if __name__ == "__main__":
    main(*sys.argv[1:3])
