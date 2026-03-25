---
name: youtube
description: >
  Free YouTube research tool using yt-dlp. Get video transcripts, search YouTube,
  browse channels and playlists, extract metadata. No API key required.
  Use when: user asks about YouTube videos, wants transcripts, searches for videos,
  asks "what does this video say", shares a YouTube link, or needs video metadata.
---

# YouTube Research (yt-dlp)

Free YouTube toolkit. No API key, no credits, no limits.

## Get Transcript

Extract auto-generated or manual subtitles from any video:

```bash
cd /tmp && yt-dlp --write-auto-subs --sub-lang en --skip-download --sub-format vtt -o "%(id)s" "<VIDEO_URL>" 2>/dev/null && cat *.vtt && rm -f *.vtt *.json
```

For Russian subtitles use `--sub-lang ru`. For both: `--sub-lang en,ru`.

If no auto-subs exist, try manual subs:
```bash
yt-dlp --write-subs --sub-lang en --skip-download --sub-format vtt -o "%(id)s" "<VIDEO_URL>"
```

To list available subtitle languages:
```bash
yt-dlp --list-subs "<VIDEO_URL>" 2>/dev/null | head -30
```

## Search Videos

Search YouTube and get top results with metadata:

```bash
yt-dlp "ytsearch10:<QUERY>" --flat-playlist --dump-single-json 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  (d.entries||[]).forEach((e,i) => {
    console.log(\`\${i+1}. \${e.title}\`);
    console.log(\`   URL: https://youtube.com/watch?v=\${e.id}\`);
    console.log(\`   Channel: \${e.channel||e.uploader||'?'} | Duration: \${e.duration_string||'?'}\`);
    console.log();
  });
"
```

Change `ytsearch10` number for more/fewer results (e.g., `ytsearch5`, `ytsearch20`).

## Video Metadata

Get full info about a video (title, description, views, likes, upload date, etc.):

```bash
yt-dlp --dump-json --skip-download "<VIDEO_URL>" 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Title:', d.title);
  console.log('Channel:', d.channel);
  console.log('Upload date:', d.upload_date);
  console.log('Views:', d.view_count);
  console.log('Likes:', d.like_count);
  console.log('Duration:', d.duration_string);
  console.log('Description:', (d.description||'').slice(0, 500));
"
```

## Channel Videos

List recent videos from a channel:

```bash
yt-dlp --flat-playlist --dump-single-json "https://youtube.com/@CHANNEL_HANDLE/videos" 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  (d.entries||[]).slice(0,15).forEach((e,i) => {
    console.log(\`\${i+1}. \${e.title} (\${e.duration_string||'?'})\`);
    console.log(\`   https://youtube.com/watch?v=\${e.id}\`);
  });
"
```

## Playlist Contents

```bash
yt-dlp --flat-playlist --dump-single-json "<PLAYLIST_URL>" 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Playlist:', d.title, '—', (d.entries||[]).length, 'videos');
  (d.entries||[]).forEach((e,i) => {
    console.log(\`\${i+1}. \${e.title} (\${e.duration_string||'?'})\`);
    console.log(\`   https://youtube.com/watch?v=\${e.id}\`);
  });
"
```

## Tips

- YouTube URLs: `https://youtube.com/watch?v=VIDEO_ID` or `https://youtu.be/VIDEO_ID`
- Channel URLs: `https://youtube.com/@handle` or `https://youtube.com/channel/UCXXXX`
- Always use `2>/dev/null` to suppress yt-dlp progress output
- VTT format includes timestamps — useful for referencing specific moments
- For very long transcripts, pipe through `head -200` to avoid overwhelming context
