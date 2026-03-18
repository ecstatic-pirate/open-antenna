---
name: read-podcast
description: >
  Extracts structured knowledge from YouTube podcasts and video content.
  Use when: "/read-podcast <url>", "watch this podcast", "extract from this video",
  "summarize this YouTube video", user provides a YouTube URL with intent to learn from it.
  Two modes: default (knowledge extraction) and --study (knowledge + delivery craft analysis).
  Requires Claude Code CLI and Python 3 with yt-transcript.sh available, or yt-dlp installed.
allowed-tools: Read, Write, Bash
---

# Read Podcast

Extracts structured knowledge from YouTube video content. Requires a transcript. Does not hallucinate content from titles, descriptions, or model training knowledge — transcript or nothing.

---

## Trigger Detection

| Input | Mode |
|-------|------|
| `/read-podcast <url>` | Mode 1: Knowledge Extraction |
| `/read-podcast --study <url>` | Mode 2: Knowledge + Delivery Craft |
| `/read-podcast --topic "X" <url>` | Mode 1 with topic filter |
| "watch this podcast [url]" | Mode 1 |
| "extract from this video [url]" | Mode 1 |

Parameters:
- `url` (required) — YouTube video URL
- `--topic <filter>` (optional) — extract only content about this topic
- `--study` (optional) — adds delivery craft analysis

---

## Step 1: Validate URL

Confirm the URL is a YouTube video (`youtube.com/watch?v=` or `youtu.be/`). If not, fail with: "Not a YouTube URL."

---

## Step 2: Fetch Transcript

Try methods in sequence until one works:

**Method 1 — yt-dlp (auto-captions):**
```bash
video_id=$(echo "{url}" | grep -oP '(?<=v=)[^&]+' || echo "{url}" | grep -oP '(?<=youtu.be/)[^?]+')
yt-dlp --skip-download --write-auto-sub --sub-lang en --sub-format vtt \
  -o /tmp/yt-{video_id} "https://www.youtube.com/watch?v={video_id}" 2>/dev/null
# Convert VTT to plain text (strip timestamps and duplicate lines)
cat /tmp/yt-{video_id}.en.vtt 2>/dev/null | grep -v '^WEBVTT' | grep -v '^$' \
  | grep -v '^[0-9][0-9]:[0-9][0-9]' | sort -u > /tmp/yt-{video_id}-transcript.txt
```

**Method 2 — youtube-transcript-api (Python):**
```bash
pip install youtube-transcript-api -q
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
import json, sys
tid = '{video_id}'
t = YouTubeTranscriptApi.get_transcript(tid, languages=['en', 'en-US'])
print(' '.join(s['text'] for s in t))
" > /tmp/yt-{video_id}-transcript.txt 2>/dev/null
```

**Method 3 — Jina Reader (last resort for well-captioned videos):**
```bash
curl -s "https://r.jina.ai/https://www.youtube.com/watch?v={video_id}" > /tmp/yt-{video_id}-transcript.txt
```

**Hard rule:** If the transcript is empty after all methods, fail cleanly:
> "No transcript available for this video. YouTube transcripts typically appear within 24h of upload. Retry later."

Do NOT extract from chapter titles, video description, or model training knowledge. There is no best-effort mode. A fabricated extraction is worse than no extraction.

---

## Step 3: Get Video Metadata

```bash
yt-dlp --skip-download --print "%(title)s|%(channel)s|%(duration)s|%(upload_date)s" \
  "https://www.youtube.com/watch?v={video_id}" 2>/dev/null
```

Parse: title, channel name, duration (seconds), upload date.

Format duration as HH:MM:SS from seconds value.

**Minimum length check:** If duration < 300 seconds (5 minutes), fail with: "Too short to extract — not a full podcast."

---

## Step 4: Chunk if Needed

| Video length | Words (~) | Strategy |
|-------------|-----------|----------|
| < 45 min | < 8K | Single pass — process full transcript |
| 45 min – 2 hr | 8–20K | Split into 4–6 chunks of ~3K words, 200-word overlap |
| 2+ hours | 20K+ | Split into 8–10 chunks. If topic filter: score by keyword density, drop low-scoring chunks |

For chunked processing:
- Extract key claims, frameworks, quotes, and stories per chunk.
- Tag each with approximate timestamp.
- After all chunks: synthesize — deduplicate, rank by insight density, group by theme (not chronology).

---

## Step 5: Extract and Format

### Writing standard

Easy to read on first pass. Short sentences. Plain language. If a bullet requires re-reading, simplify it.

**Readability rules:**
- **First-pass clarity.** Reader gets it immediately. No re-reading.
- **Ground abstract concepts instantly.** Follow unfamiliar terms with a concrete example inline.
- **Everyday language over jargon.** Define coined terms inline (e.g., "allostatic load — the accumulated cost of stress, like interest on debt").
- **Density means meaning, not compression.** Every word earns its place. No collapsed jargon clauses.
- **The midnight test.** Would someone reading this at midnight after a long day understand immediately? If not, rewrite.

### Key Ideas rules
- 7-12 bullets, each a specific non-obvious claim with evidence
- Attribution: `**[Speaker]:**` when identifiable
- Timestamp: `` `[~H:MM]` `` when available
- Collapse repeated ideas into the strongest version
- Distinguish original guest ideas from host restatements

---

## Step 6: Derive File Identifiers

- **channel-slug** — lowercase, spaces→hyphens, strip special chars (e.g., `lennys-podcast`)
- **title-slug** — first 4-5 meaningful words, same treatment (e.g., `how-cursor-got-to-300m`)
- Output path: `{output_dir}/podcasts/{channel-slug}-{title-slug}.md`

---

## Step 7: Write the File

Use this template:

```markdown
---
type: podcast
source: "{channel name} — {video title}"
url: {full YouTube URL}
date: {YYYY-MM-DD}
duration: {HH:MM:SS}
host: {host name or "unknown"}
guest: {guest name(s) or "none"}
topic_filter: {filter text, or "none"}
mode: extraction | study
transcript_via: yt-dlp | youtube-transcript-api | jina
---

# {Channel Name} — {Video Title}

## Source
**URL:** {full YouTube URL}
**Channel:** {channel name}
**Duration:** {HH:MM:SS}
**Host:** {name}
**Guest(s):** {name(s)}
**Date:** {YYYY-MM-DD}
**Transcript via:** {method used}

---

## Context
Who are the speakers? What's this podcast about? What's the guest's credibility on this topic? 2-3 sentences.

---

## Key Ideas

7-12 bullets. Each = one specific, non-obvious claim with evidence or reasoning.

- **[Claim label]** `[~H:MM]` {specific claim}. {evidence, mechanism, or story cited}.

---

## Models & Frameworks

| Model | Description | Speaker |
|-------|-------------|---------|
| **{Name}** | {what it is, how it works} | {who introduced it} |

---

## Stories & Examples

The 3-5 most illustrative stories or case studies.

- **{Story label}** `[~H:MM]` {what happened, what it illustrates, why it matters}

---

## Tactical Moves

Concrete actions you could take. Not observations — things you could do tomorrow.

- {action} — {why / what it produces}

---

## Quotable

3-5 verbatim quotes from the transcript.

> "{exact quote}" — {speaker} `[~H:MM]`

---

## Timestamps Index

Key moments for re-listening. Only include if timestamps were preserved.

| Time | Topic |
|------|-------|
| ~0:05:00 | {topic} |
```

---

## Mode 2 Only: Delivery Craft Analysis (--study flag)

Run Steps 1–7 first. Then append a `## Delivery Craft` section:

```markdown
---

## Delivery Craft

3-5 named patterns. For each:

### {Pattern Name}
**What they do:** {description}
**Example from this episode:** {quote or paraphrase with timestamp}
**Why it works:** {mechanism}
**Try this:** {how you could apply it in writing or speaking}
```

**What to analyze:**
- **Opening technique** — how does the host/guest frame the conversation?
- **Storytelling mechanics** — how are stories set up, paced, and landed?
- **Reframing moves** — when the guest reframes a question, what technique do they use?
- **Compression** — how do they make complex ideas accessible in conversation?
- **Signature phrases** — recurring verbal patterns that make ideas stick

---

## Output Summary

After completing, report:

```
Podcast: {channel} — {title}
Saved: {output_dir}/podcasts/{channel-slug}-{title-slug}.md
Duration: {HH:MM:SS} | Transcript: {method}
```

---

## Quality Checks

Before reporting done:

1. All sections present: Context, Key Ideas, Models & Frameworks, Stories & Examples, Tactical Moves, Quotable, Timestamps Index.
2. Key Ideas: 7-12 bullets, each with a specific claim (not vague summary).
3. Transcript method noted in frontmatter and Source section.
4. Duration present.
5. File written to `{output_dir}/podcasts/`.
6. [Mode 2] Delivery Craft section present.
