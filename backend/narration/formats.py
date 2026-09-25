"""Small bounded container checks, without fetching media or executing decoders."""
import io
import struct
import wave
from pathlib import Path

from django.core.exceptions import ValidationError
from .models import MAX_AUDIO_BYTES


def _boxes(data):
    offset = 0
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError
        size, kind = struct.unpack('>I4s', data[offset:offset + 8])
        if size < 8 or offset + size > len(data):
            raise ValueError
        yield kind, data[offset + 8:offset + size]
        offset += size


def _m4a(data):
    boxes = list(_boxes(data))
    if not boxes or boxes[0][0] != b'ftyp' or len(boxes[0][1]) < 8:
        raise ValueError
    brands = boxes[0][1][:4] + boxes[0][1][8:]
    if not any(brand in brands for brand in (b'M4A ', b'isom', b'mp42')):
        raise ValueError
    if not any(kind == b'mdat' and payload for kind, payload in boxes):
        raise ValueError
    handlers, codecs = [], []

    def inspect(payload, depth=0):
        if depth > 6:
            raise ValueError
        for kind, body in _boxes(payload):
            if kind in (b'moov', b'trak', b'mdia', b'minf', b'stbl'):
                inspect(body, depth + 1)
            elif kind == b'hdlr':
                handlers.append(body[8:12])
            elif kind == b'stsd':
                if len(body) < 8:
                    raise ValueError
                codecs.extend(kind for kind, _ in _boxes(body[8:]))
    inspect(data)
    if not handlers or any(kind != b'soun' for kind in handlers) or not codecs or any(kind != b'mp4a' for kind in codecs):
        raise ValueError


def _mp3(data):
    offset = 0
    if data.startswith(b'ID3'):
        if len(data) < 10 or data[3] not in (2, 3, 4) or any(value & 128 for value in data[6:10]):
            raise ValueError
        offset = 10 + sum(value << shift for value, shift in zip(data[6:10], (21, 14, 7, 0)))
        if data[3] == 4 and data[5] & 16:
            offset += 10
    frames = 0
    while frames < 2:
        if offset + 4 > len(data):
            raise ValueError
        header = int.from_bytes(data[offset:offset + 4], 'big')
        version, layer = (header >> 19) & 3, (header >> 17) & 3
        bitrate, sample, padding = (header >> 12) & 15, (header >> 10) & 3, (header >> 9) & 1
        if header >> 21 != 0x7ff or version == 1 or layer != 1 or bitrate in (0, 15) or sample == 3:
            raise ValueError
        rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] if version == 3 else [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
        frequency = (44100, 48000, 32000)[sample] // (1 if version == 3 else 2 if version == 2 else 4)
        offset += (144000 if version == 3 else 72000) * rates[bitrate] // frequency + padding
        if offset > len(data):
            raise ValueError
        frames += 1


def validate_audio(data, filename):
    if not isinstance(data, bytes) or not 0 < len(data) <= MAX_AUDIO_BYTES:
        raise ValidationError('音频须为不超过 8MB 的非空文件。')
    extension = Path(filename).suffix.lower()
    try:
        if extension == '.wav':
            if data[:4] != b'RIFF' or data[8:12] != b'WAVE' or int.from_bytes(data[4:8], 'little') + 8 != len(data):
                raise ValueError
            with wave.open(io.BytesIO(data)) as audio:
                if (audio.getcomptype() != 'NONE' or audio.getnchannels() not in (1, 2) or audio.getnframes() <= 0
                        or not 8000 <= audio.getframerate() <= 192000 or audio.getsampwidth() not in (1, 2, 3, 4)):
                    raise ValueError
                if len(audio.readframes(audio.getnframes())) != audio.getnframes() * audio.getnchannels() * audio.getsampwidth():
                    raise ValueError
            return 'wav', 'audio/wav'
        if extension == '.mp3':
            _mp3(data)
            return 'mp3', 'audio/mpeg'
        if extension == '.m4a':
            _m4a(data)
            return 'm4a', 'audio/mp4'
    except (ValueError, IndexError, struct.error, wave.Error, EOFError):
        pass
    raise ValidationError('文件内容与受支持的 MP3、AAC 编码 M4A 或 PCM WAV 格式不符。')
