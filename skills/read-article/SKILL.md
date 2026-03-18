---
name: read-article
description: >
  Extracts structured knowledge from articles and web content.
  Use when: "/read-article <url>", "read this article", "summarize this article",
  "extract from this", user provides a URL to an article, blog post, or web page.
  Two modes: default (knowledge extraction) and --study (knowledge + writing craft analysis).
allowed-tools: Read, Write, Bash, WebFetch
---

# Read Article

Extracts structured knowledge from articles. Two modes: knowledge extraction (default) and writing craft study (`--study` flag). Output goes to the configured output directory.

---

## Trigger Detection

| Input | Mode |
|-------|------|
| `/read-article <url>` | Mode 1: Knowledge Extraction |
| `/read-article --study <url>` | Mode 2: Knowledge + Writing Craft |
| "read this article [url]" | Mode 1 |
| "study this [url]" | Mode 2 |
| "summarize this [url]" | Mode 1 |

If no URL is provided, ask for one. Do not proceed without a URL.

---

## Step 1: Fetch the Article

**Primary method — Jina Reader:**
```bash
curl -s "https://r.jina.ai/{url}"
```

Handles JS-rendered pages, returns clean markdown. Works for most blogs, newsletters, and news sites.

**Completeness check:** After fetching, verify the content looks complete. Signs of partial fetch: section headers with missing content, numbered lists that stop early, table of contents with uncovered sections, suspiciously short content. If incomplete, re-fetch or try the next method.

**Fallback — WebFetch tool:**
If Jina fails or content is too thin, use the WebFetch tool. Note: "Fetched via WebFetch fallback (Jina failed)".

If both fail: stop and report. Do not fabricate article content.

---

## Step 2: Derive File Identifiers

From the article content and URL:

- **author** — social handle or author name, lowercase, no spaces (e.g., `paul-graham`, `naval`)
- **slug** — 3-5 word kebab-case summary of article title (e.g., `how-to-get-rich`, `do-things-that-dont-scale`)
- **date** — today's date (YYYY-MM-DD)

Output file path: `{output_dir}/articles/{author}-{slug}.md`

---

## Step 3: Extract Structured Knowledge

### Quality standard

Every key idea must be something the reader couldn't guess from the title alone. "Specialization is limiting" is not a key idea. "Schools were designed to produce punctual factory workers — the guilt about not niching down is systemically installed" is a key idea.

**Evidence standard:** Each bullet = the specific argument + the evidence. Not a thesis. Not a summary. The actual claim the author made, with the mechanism or evidence they cited.

### Writing standard

Easy to read on first pass. Short sentences. Plain language. If a bullet requires re-reading, simplify it. Dense with insight — readable insight, not academic density.

**Readability rules:**
- **First-pass clarity.** Write so the reader gets it immediately. No re-reading required.
- **Ground abstract concepts instantly.** Follow unfamiliar concepts with a concrete example in the same sentence or next.
- **Everyday language over jargon.** Use plain words. Define coined terms inline in plain English.
- **Density means meaning, not compression.** Pack sentences with insight, not with compressed jargon.
- **The midnight test.** Would someone reading this at midnight after a long day understand it immediately? If not, rewrite it.

### Extraction template

```markdown
---
source: "{article title}"
url: {full URL}
author: {author}
date: {YYYY-MM-DD}
mode: extraction | study
fetch_method: jina | webfetch
---

# {Author} — {Article Title}

## Source
**URL:** {full URL}
**Author:** {author}
**Date:** {YYYY-MM-DD}

---

## Big Picture

What is this person saying, in 2-3 sentences? No jargon. Like explaining it to a friend.

---

## Key Questions & Answers

The main questions the article answers. For each:

**Q: {question the article answers}**
- {plain-language answer with evidence}
- {specific example or mechanism}
- {another concrete point}

(Repeat for every major argument. A 6-section article gets ~6 questions.)

---

## Models & Frameworks

Named or unnamed mental models introduced. Use a table when 3+. Skip if none.

| Model | Description |
|-------|-------------|
| **{Name}** | {what it is, how it works, what it explains} |

---

## Tactical Moves

Concrete actions recommended. Things you could do tomorrow. Skip if the article is purely analytical.

- {action} — {why / what it produces}

---

## Key Quotes

2-3 lines worth saving verbatim.

> "{exact quote}"

---

{Mode 2 only: Writing Craft section appended below}
```

---

## Step 4: Save the Extraction File

Write to `{output_dir}/articles/{author}-{slug}.md`.

Create the directory if it doesn't exist.

---

## Mode 2 Only: Writing Craft Analysis (--study flag)

Run Steps 1-4 first. Then append a `## Writing Craft` section to the extraction file:

```markdown
---

## Writing Craft

### Hook Technique
How does the article open? What emotion or frame does it establish? How does it earn the reader's attention in the first 100 words?

### Transitions
How does the author move between sections? Questions? Statement + pivot? Recap + lift? Describe the mechanics, not just "it flows well."

### Persuasion Patterns
What resistance does the author anticipate? How do they handle it? De-cringe moves, villain setups, authority citations, reframing.

### Pacing
Where does it slow down? Where does it speed up? How are single-sentence paragraphs used?

### Specificity as Trust
Where does the author use specific numbers or examples? Is there a pattern to when specificity appears vs. when logic carries alone?
```

---

## Output Summary

After completing all steps, report:

```
Read: {author} — {title}
Saved: {output_dir}/articles/{author}-{slug}.md
[Mode 2 only: Writing craft analysis added]
```

Nothing else. The file is the output.

---

## Quality Checks

Before reporting done:

1. Key Ideas contain specific claims with evidence, not thesis-level summaries.
2. Big Picture is 2-3 sentences, no jargon.
3. File written to correct path under `{output_dir}/articles/`.
4. [Mode 2] Writing Craft section present in the file.
