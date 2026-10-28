# Golden media

Synthetic inputs for the photo and voice golden cases. The stores are
fictional and the voice is macOS `say`; nothing here comes from a real
receipt or recording.

Regenerate on macOS from this directory:

```sh
rsvg-convert receipt.svg -o receipt.png
rsvg-convert receipt-no-date.svg -o receipt-no-date.png
say -o note.aiff "Three twenty five for a coffee at Coffee Cart."
afconvert -f caff -d opus@48000 -b 32000 -c 1 note.aiff note.caf
python3 caf2ogg.py note.caf note.ogg  # OGG/Opus, like a Telegram voice note
rm note.aiff note.caf
```

`afconvert` encodes Opus but fails to write an Ogg file (`'pck?'`), so
`caf2ogg.py` (stdlib Python) rewraps the Opus packets in Ogg pages. That
avoids installing ffmpeg. `afinfo note.ogg` should report mono, 48000 Hz,
Opus, about 2.7 seconds.

The contents must keep matching each case's `expect` (merchant, date,
line count). After changing one, run `npm run eval -- --record`.
